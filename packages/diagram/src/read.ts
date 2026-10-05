import {
  Work,
  failure,
  fieldDefinition,
  assertIndex,
  bitAt,
  textAt,
  rowAt,
  rowCount,
  type Column,
  type FieldInput,
  type Index,
  type ReadScope,
  type TypeDefinition,
} from '@latkit/model';
import { kit, type TextLayout, type TextLayoutInput } from '@latkit/gpu';
import type {
  DiagramData,
  VertexOptions,
  EdgeOptions,
  DiagramLabels,
  PortOptions,
} from './data.js';
import type { Scene, Vertex, Edge, Port } from './scene.js';
import { emptyLabel } from './scene.js';
import type { Limits } from './options.js';
import type { Style } from './config.js';
import { fail } from './config.js';

export type Layout = (input: TextLayoutInput) => Promise<TextLayout>;
function text(column: Column | undefined, row: number): string {
  if (!column) return '';
  if (column.kind !== 'text') fail('Expected a text label field');
  return textAt(column, row) ?? '';
}
/** What a vertex's structure reads: its size, and whether it shows. */
const VERTEX_SHAPE = {
  width: 'raw',
  height: 'raw',
  visible: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
const EDGE_SHAPE = { visible: 'raw' } as const satisfies Readonly<Record<string, kit.ChannelKind>>;
/** Where a vertex sits: read apart from its structure, so moving one rereads nothing else. */
const VERTEX_PLACE = { x: 'raw', y: 'raw' } as const satisfies Readonly<
  Record<string, kit.ChannelKind>
>;
type ShapeName = keyof typeof VERTEX_SHAPE;
type PlaceName = keyof typeof VERTEX_PLACE;
/** Rows without a value: unplaced, sized to fit, and shown. */
const UNPLACED = { x: NaN, y: NaN, width: NaN, height: NaN, visible: 1 } as const;
interface Bindings<K extends string> {
  readonly channels: kit.BoundChannels<K>;
  /** The channels' fields, and for a structure the labels' text as `label`. */
  readonly fields: Readonly<Record<string, FieldInput>>;
}
const structures = new WeakMap<object, Bindings<ShapeName>>(),
  placements = new WeakMap<object, Bindings<PlaceName>>();
/** What a type's structure reads, bound once per options object. */
export function structure(option: VertexOptions | EdgeOptions, edge: boolean): Bindings<ShapeName> {
  let found = structures.get(option);
  if (!found) {
    const channels = kit.bindChannels(
      option,
      (edge ? EDGE_SHAPE : VERTEX_SHAPE) as Readonly<Record<ShapeName, kit.ChannelKind>>,
    );
    const labels = kit.resolveLabels(option.labels);
    found = {
      channels,
      fields: { ...channels.fields, ...(labels ? { label: labels.field } : {}) },
    };
    structures.set(option, found);
  }
  return found;
}
/** Where a vertex type's rows sit, bound once per options object. */
function placement(option: VertexOptions): Bindings<PlaceName> {
  let found = placements.get(option);
  if (!found) {
    const channels = kit.bindChannels(option, VERTEX_PLACE);
    found = { channels, fields: channels.fields };
    placements.set(option, found);
  }
  return found;
}
/** Every drawn type's options, and whether it is an edge type. */
function types(data: DiagramData): [string, VertexOptions | EdgeOptions, boolean][] {
  return [
    ...Object.entries(data.vertices).map(([type, option]) => [type, option, false] as const),
    ...Object.entries(data.edges ?? {}).map(([type, option]) => [type, option, true] as const),
  ] as [string, VertexOptions | EdgeOptions, boolean][];
}
/** Whether a binding reads a sampled field, so it depends on the read coordinate. */
function sampled(data: DiagramData, type: string, input: FieldInput): boolean {
  return fieldDefinition(data.source, type, input)?.sampled === true;
}
/** Only sampled positions, geometry, visibility, and text invalidate the scene. */
export function sampledStructure(data: DiagramData): boolean {
  return types(data).some(([type, options, edge]) =>
    [
      ...Object.values(structure(options, edge).fields),
      ...(edge ? [] : Object.values(placement(options).fields)),
    ].some((input) => sampled(data, type, input)),
  );
}
/** What a scene is made of in each entry; every other option is a style the GPU reads. */
const VERTEX = [
  'rows',
  'width',
  'height',
  'shape',
  'cornerRadius',
  'labelPosition',
  'visible',
  'labels',
] as const satisfies readonly (keyof VertexOptions)[];
const PORT = ['side', 'order', 'marker', 'label'] as const satisfies readonly (keyof PortOptions)[];
const EDGE = [
  'rows',
  'ends',
  'route',
  'arrows',
  'appearance',
  'visible',
  'labels',
] as const satisfies readonly (keyof EdgeOptions)[];
const PLACE = ['x', 'y'] as const satisfies readonly (keyof VertexOptions)[];
/** Whether two diagrams have one structure, so only positions and styles changed between them. */
export function sameStructure(a: DiagramData, b: DiagramData): boolean {
  return (
    kit.sameRecords(a.vertices, b.vertices, VERTEX) &&
    Object.keys(a.vertices).every((type) =>
      kit.sameRecords(a.vertices[type].ports, b.vertices[type].ports, PORT),
    ) &&
    kit.sameRecords(a.edges, b.edges, EDGE) &&
    a.groups === b.groups &&
    (a.source === b.source ||
      (local(a) && local(b) && kit.sameValues(a.source, b.source, structural(b))))
  );
}
/** Whether two diagrams of one structure place their vertices alike. */
export function samePlacement(a: DiagramData, b: DiagramData): boolean {
  if (!kit.sameRecords(a.vertices, b.vertices, PLACE)) return false;
  if (a.source === b.source) return true;
  const named = new Map<string, string[]>();
  for (const [type, option] of Object.entries(b.vertices))
    named.set(
      type,
      Object.values(placement(option).fields).filter(
        (input): input is string => typeof input === 'string',
      ),
    );
  return kit.sameValues(a.source, b.source, (type) => named.get(type) ?? []);
}
/** The fields of each type a scene reads, by name in the drawn source, for change detection. */
export function structural(
  data: DiagramData,
): (type: string, definition: TypeDefinition) => string[] {
  const named = new Map<string, Set<string>>();
  const add = (type: string, input: FieldInput) => {
    if (typeof input !== 'string') return;
    let fields = named.get(type);
    if (!fields) named.set(type, (fields = new Set()));
    fields.add(input);
  };
  for (const [type, option, edge] of types(data))
    for (const input of Object.values(structure(option, edge).fields)) add(type, input);
  return (type, definition) => [
    ...(named.get(type) ?? []),
    ...Object.keys(definition.fields).filter((field) => {
      const kind = definition.fields[field].type;
      return typeof kind === 'object' && kind.kind === 'reference';
    }),
  ];
}
/**
 * Read where a scene's vertices sit again, its structure standing: a vertex its data places moves
 * there, and one without stays where it was drawn.
 */
export async function readPlacement(
  scene: Scene,
  data: DiagramData,
  reader: ReadScope,
  work: Work,
): Promise<void> {
  for (const [type, option] of Object.entries(data.vertices)) {
    const first = scene.types.vertices.get(type)?.first;
    if (first === undefined) continue;
    const { channels, fields } = placement(option),
      read = await kit.resolveChannels(
        reader,
        { source: data.source, from: type, rows: option.rows },
        channels,
        UNPLACED,
      );
    let i = first;
    for await (const tile of reader.fields({
      source: data.source,
      from: type,
      rows: option.rows,
      fields,
    })) {
      await work.step();
      for (let k = 0; k < rowCount(tile.rows); k++, i++) {
        const vertex = scene.vertices[i];
        if (vertex?.index.type !== type || vertex.row !== rowAt(tile.rows, k))
          throw failure('conflict', 'Rows changed without the structure');
        const x = kit.channelValue(read.x, tile, k),
          y = kit.channelValue(read.y, tile, k);
        vertex.placed = Number.isFinite(x) && Number.isFinite(y);
        if (vertex.placed) {
          vertex.x = x;
          vertex.y = y;
        }
        vertex.pinned = true;
      }
    }
  }
}
/** Whether the structure reads only the drawn source, so its tables say when it changed. */
export function local(data: DiagramData): boolean {
  return types(data).every(([, option, edge]) =>
    Object.values(structure(option, edge).fields).every((input) => typeof input === 'string'),
  );
}
function label(
  value: string,
  config: DiagramLabels | null | undefined,
  options: Style,
  layout: Layout,
  defaults: Partial<TextLayoutInput> = {},
): Promise<TextLayout> | TextLayout {
  if (!value) return emptyLabel;
  return layout({
    text: value,
    font: config?.font ?? defaults.font ?? options.font,
    size: config?.fontSize ?? defaults.size ?? options.fontSizePx,
    color: config?.color ?? defaults.color ?? options.textColor,
    maxWidth: config?.maxWidth,
    overflow: config?.overflow,
  });
}
/** Read a diagram's structure: its vertices, their ports and text, edges, ends, and groups. */
export async function readScene(
  data: DiagramData,
  reader: ReadScope,
  options: Style,
  limits: Required<Limits>,
  layout: Layout,
  work: Work = new Work(reader.signal, limits.layoutMs),
): Promise<Scene> {
  const check = () => work.check();
  const scene: Scene = {
    data,
    vertices: [],
    edges: [],
    groups: [],
    parts: [],
    bounds: [0, 0, 0, 0],
    bytes: 0,
    routeBytes: 0,
    ends: 0,
    slots: { ports: 0, edges: 0, groups: 0, count: 0 },
    types: { vertices: new Map(), edges: new Map() },
  };
  const { schema } = data.source;
  const charge = (bytes: number) => {
    scene.bytes += bytes;
    if (scene.bytes > limits.geometryBytes)
      throw failure('resource-limit', 'Diagram geometry exceeds budget');
  };
  for (const type of Object.keys(data.vertices))
    if (!schema.types[type]) fail('Unknown vertex type: ' + type);
  const wirings = kit.wiring(schema, Object.keys(data.vertices), data.edges ?? {});
  const byType = new Map<string, Map<number, number>>(),
    indices = new Map<string, Index>();
  /** Each vertex type's ports and the net each names. */
  const portsOf = new Map<string, (kit.Port & { net: string })[]>();
  /** Each port wired to a net row: its vertex and port, by net type. */
  const wired = new Map<
    string,
    { index?: Index; vertex: number[]; port: string[]; row: number[] }
  >();
  for (const [net, wiring] of wirings) {
    if (wiring.kind !== 'net') continue;
    wired.set(net, { vertex: [], port: [], row: [] });
    for (const port of wiring.ports)
      portsOf.set(port.type, [...(portsOf.get(port.type) ?? []), { ...port, net }]);
  }
  // Titles are set a step bolder than the text beside them; port names quieter.
  const title = { font: { ...options.font, weight: 600 } },
    quiet = {
      size: options.portFontSize,
      color: [
        options.textColor[0],
        options.textColor[1],
        options.textColor[2],
        options.textColor[3] * 0.66,
      ] as const,
    };
  let portSlots = 0;
  for (const [type, option] of Object.entries(data.vertices)) {
    const definition = schema.types[type],
      order = Object.keys(definition.fields);
    const ports = (portsOf.get(type) ?? []).sort(
      (a, b) => order.indexOf(a.field) - order.indexOf(b.field),
    );
    for (const name of Object.keys(option.ports ?? {}))
      if (!ports.some((port) => port.field === name)) fail('Unknown port: ' + type + '.' + name);
    const start = scene.vertices.length,
      texts: string[] = [];
    scene.types.vertices.set(type, {
      first: start,
      ports: portSlots,
      names: ports.map((port) => port.field),
    });
    const shape = structure(option, false),
      place = placement(option),
      scope = { source: data.source, from: type, rows: option.rows },
      read = await kit.resolveChannels(reader, scope, shape.channels, UNPLACED),
      at = await kit.resolveChannels(reader, scope, place.channels, UNPLACED);
    const rows = new Map<number, number>();
    byType.set(type, rows);
    for await (const tile of reader.fields({
      ...scope,
      fields: { ...shape.fields, ...place.fields },
      ids: true,
    })) {
      if (!tile.ids) fail('Vertex IDs were not returned');
      indices.set(type, tile.index);
      await work.step();
      for (let i = 0; i < rowCount(tile.rows); i++) {
        check();
        if (scene.vertices.length >= limits.vertices)
          throw failure('resource-limit', 'Too many diagram vertices');
        charge(512 + ports.length * 192);
        const row = rowAt(tile.rows, i);
        if (rows.has(row)) fail('Duplicate vertex row');
        const id = textAt(tile.ids, i);
        if (id === null) fail('Missing vertex identity');
        const x = kit.channelValue(at.x, tile, i),
          y = kit.channelValue(at.y, tile, i),
          width = kit.channelValue(read.width, tile, i),
          height = kit.channelValue(read.height, tile, i),
          placed = Number.isFinite(x) && Number.isFinite(y);
        if (width <= 0 || height <= 0) fail('Vertex size must be positive');
        const shown = kit.channelOn(read.visible, tile, i);
        texts.push(text(tile.columns.label, i));
        const vertex: Vertex = {
          hit: { kind: 'vertex', id, source: data.source, index: tile.index, row },
          index: tile.index,
          row,
          x: placed ? x : 0,
          y: placed ? y : 0,
          width: width || 0,
          height: height || 0,
          header: 0,
          placed,
          pinned: placed,
          shape: option.shape ?? 'rounded',
          radius: option.cornerRadius ?? options.cornerRadius,
          visible: shown,
          sourceVisible: shown,
          label: emptyLabel,
          ports: [],
          portSlot: portSlots,
          options: option,
        };
        for (const { field: name, net, direction } of ports) {
          const p = option.ports?.[name];
          vertex.ports.push({
            name,
            to: net,
            ...(direction ? { direction } : {}),
            marker: p?.marker ?? options.portMarker,
            connected: false,
            order: p?.order ?? vertex.ports.length,
            side: p?.side ?? (direction === 'in' ? 'left' : 'right'),
            label: emptyLabel,
            position: [0, 0],
            normal: [0, 0],
          });
        }
        portSlots += ports.length;
        rows.set(row, scene.vertices.length);
        scene.vertices.push(vertex);
      }
    }
    if (ports.length)
      for await (const block of reader.read(data.source, {
        kind: 'rows',
        from: type,
        rows: option.rows,
        select: ports.map((port) => port.field),
      })) {
        await work.step();
        const columns = ports.map(({ field: name, net: to }) => {
          const column = block.columns[name];
          if (column?.kind !== 'reference') fail('Expected a reference column: ' + name);
          const net = wired.get(to)!;
          if (net.index) assertIndex(net.index, column.index);
          else net.index = column.index;
          return { name, column, net };
        });
        // A net's ends follow vertex order, then port order.
        for (let i = 0; i < rowCount(block.rows); i++) {
          const vertex = rows.get(rowAt(block.rows, i));
          if (vertex === undefined) continue;
          for (const { name, column, net } of columns) {
            const at = column.offset + i;
            if (!bitAt(column.validity, at)) continue;
            net.vertex.push(vertex);
            net.port.push(name);
            net.row.push(column.values[at]);
          }
        }
      }
    const portLabels = new Map<string, TextLayout>();
    for (const port of options.portLabels ? ports : []) {
      const text = option.ports?.[port.field]?.label ?? definition.fields[port.field].label;
      portLabels.set(port.field, await label(text ?? port.field, null, options, layout, quiet));
    }
    const labels = kit.resolveLabels(option.labels),
      maxCount = labels?.maxCount ?? Infinity;
    for (let i = start; i < scene.vertices.length; i++) {
      const vertex = scene.vertices[i];
      if (i - start < maxCount)
        vertex.label = await label(texts[i - start], labels, options, layout, title);
      for (const port of vertex.ports) port.label = portLabels.get(port.name) ?? emptyLabel;
      size(vertex, options);
      charge(vertex.label.runs.length * 128);
      check();
    }
  }
  scene.slots.ports = scene.vertices.length;
  for (const vertex of scene.vertices) vertex.portSlot += scene.slots.ports;
  for (const at of scene.types.vertices.values()) at.ports += scene.slots.ports;
  const end = (edge: Edge, vertex: number, port: string | null, direction?: 'in' | 'out') => {
    if (++scene.ends > limits.ends) throw failure('resource-limit', 'Too many edge ends');
    charge(48);
    edge.ends.push({ vertex, port, ...(direction ? { direction } : {}) });
  };
  for (const [type, option] of Object.entries(data.edges ?? {})) {
    const wiring = wirings.get(type)!;
    const edgeRows = new Map<number, Edge>(),
      start = scene.edges.length,
      texts: string[] = [];
    scene.types.edges.set(type, { first: start });
    let index: Index | undefined;
    const { channels, fields } = structure(option, true),
      read = await kit.resolveChannels(
        reader,
        { source: data.source, from: type, rows: option.rows },
        channels,
        UNPLACED,
      );
    for await (const tile of reader.fields({
      source: data.source,
      from: type,
      rows: option.rows,
      fields,
      ids: true,
    })) {
      if (!tile.ids) fail('Edge IDs were not returned');
      index = tile.index;
      await work.step();
      for (let i = 0; i < rowCount(tile.rows); i++) {
        check();
        if (scene.edges.length >= limits.edges)
          throw failure('resource-limit', 'Too many diagram edges');
        charge(384);
        const row = rowAt(tile.rows, i),
          id = textAt(tile.ids, i);
        if (id === null || edgeRows.has(row)) fail('Missing or duplicate edge identity');
        texts.push(text(tile.columns.label, i));
        const edge: Edge = {
          hit: { kind: 'edge', id, source: data.source, index: tile.index, row },
          ends: [],
          visible: kit.channelOn(read.visible, tile, i),
          label: emptyLabel,
          options: option,
          paths: [],
          offsets: [],
          arrows: [],
          junctions: [],
          bounds: [0, 0, 0, 0],
          route: null,
          labels: [],
        };
        edgeRows.set(row, edge);
        scene.edges.push(edge);
      }
    }
    if (wiring.kind === 'ends') {
      // A row's own ends, ordered source to target.
      for await (const block of reader.read(data.source, {
        kind: 'rows',
        from: type,
        rows: option.rows,
        select: wiring.ends.map((e) => e.field),
      })) {
        await work.step();
        const columns = wiring.ends.map(({ field, type: to }) => {
          const column = block.columns[field];
          if (column?.kind !== 'reference') fail('Expected a reference column: ' + field);
          const target = indices.get(to);
          if (target) assertIndex(target, column.index);
          return { column, rows: byType.get(to)! };
        });
        for (let i = 0; i < rowCount(block.rows); i++) {
          check();
          const edge = edgeRows.get(rowAt(block.rows, i));
          if (!edge) fail('Ends name an unselected edge row');
          columns.forEach(({ column, rows }, side) => {
            const at = column.offset + i;
            if (!bitAt(column.validity, at)) return;
            const vertex = rows.get(column.values[at]);
            if (vertex !== undefined) end(edge, vertex, null, side ? 'in' : 'out');
          });
        }
      }
    } else {
      const net = wired.get(type)!;
      if (index && net.index) assertIndex(index, net.index);
      for (let i = 0; i < net.vertex.length; i++) {
        check();
        const edge = edgeRows.get(net.row[i]);
        if (!edge) continue;
        const vertex = net.vertex[i],
          port = scene.vertices[vertex].ports.find((p) => p.name === net.port[i])!;
        port.connected = true;
        end(edge, vertex, port.name, port.direction);
      }
    }
    const labels = kit.resolveLabels(option.labels),
      maxCount = labels?.maxCount ?? Infinity;
    for (let i = start; i < Math.min(scene.edges.length, start + maxCount); i++) {
      scene.edges[i].label = await label(texts[i - start], labels, options, layout, {
        size: options.portFontSize,
      });
      charge(scene.edges[i].label.runs.length * 128);
    }
  }
  scene.slots.edges = scene.vertices.length + portSlots;
  for (const [id, group] of Object.entries(data.groups ?? {})) {
    const members: number[] = [];
    for (const [type, selection] of Object.entries(group.vertices)) {
      if (!byType.has(type)) fail('Unknown group vertex type: ' + type);
      for await (const block of reader.read(data.source, {
        kind: 'rows',
        from: type,
        rows: selection,
        select: [],
      })) {
        await work.step();
        for (let at = 0; at < rowCount(block.rows); at++) {
          const i = byType.get(type)?.get(rowAt(block.rows, at));
          if (i === undefined) continue;
          const vertex = scene.vertices[i];
          assertIndex(vertex.index, block.index);
          if (vertex.group) fail('A vertex may belong to only one direct group');
          vertex.group = id;
          members.push(i);
          charge(8);
        }
      }
    }
    charge(256 + (group.label?.length ?? id.length) * 2);
    const text = await label(group.label ?? id, null, options, layout, title);
    scene.groups.push({
      id,
      label: text,
      bounds: [0, 0, 0, 0],
      header: text.height + options.vertexPadding * 1.5,
      collapsed: group.collapsed ?? false,
      members,
      parent: group.parent,
    });
  }
  scene.slots.groups = scene.slots.edges + scene.edges.length;
  scene.slots.count = scene.slots.groups + scene.groups.length;
  return scene;
}
/** Size a vertex without an explicit size around its title and ports, on the grid. */
function size(vertex: Vertex, options: Style): void {
  const pad = options.vertexPadding,
    side = (name: Port['side']) => vertex.ports.filter((p) => p.side === name),
    widest = (ports: Port[]) => ports.reduce((m, p) => Math.max(m, p.label.width), 0);
  const across = Math.max(side('top').length, side('bottom').length) * options.portSpacing,
    along = Math.max(side('left').length, side('right').length) * options.portSpacing,
    header = vertex.options.labelPosition === 'header',
    scale = vertex.shape === 'diamond' ? 2 : vertex.shape === 'ellipse' ? Math.SQRT2 : 1;
  const top = side('top').length ? options.portFontSize * 1.5 : 0,
    bottom = side('bottom').length ? options.portFontSize * 1.5 : 0;
  vertex.header = header ? vertex.label.height + pad * 2 + top : 0;
  const autoWidth = !vertex.width,
    autoHeight = !vertex.height;
  // A centered title sits between the port names, a padding clear of each side's.
  vertex.width ||= Math.max(
    96,
    (vertex.label.width + pad * 2) * scale,
    widest(side('left')) +
      widest(side('right')) +
      pad * 3 +
      (header ? 0 : vertex.label.width + pad * 2),
    across + pad * 2,
  );
  vertex.height ||=
    scale *
    Math.max(
      40,
      vertex.label.height + pad * 2 + top + bottom,
      vertex.header + Math.max(along, options.portSpacing) + pad + bottom,
    );
  const grid = options.gridPitch;
  if (autoWidth) {
    if (vertex.shape === 'ellipse') vertex.width = Math.max(vertex.width, vertex.height * 1.4);
    if (vertex.shape === 'diamond') vertex.width = Math.max(vertex.width, vertex.height * 1.25);
    vertex.width = Math.ceil(vertex.width / grid) * grid;
  }
  if (autoHeight) vertex.height = Math.ceil(vertex.height / grid) * grid;
}
