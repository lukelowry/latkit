import {
  Work,
  failure,
  assertIndex,
  bitAt,
  numberAt,
  textAt,
  rowAt,
  rowCount,
  type Column,
  type FieldInput,
  type FieldsBlock,
  type Index,
  type ReadScope,
  type TypeDefinition,
} from '@latkit/model';
import { kit, type TextLayout, type TextLayoutInput } from '@latkit/gpu';
import type { DiagramData, VertexData, EdgeData, DiagramLabels, PortData } from './data.js';
import type { Scene, Vertex, Edge, Port } from './scene.js';
import { emptyLabel } from './scene.js';
import type { Limits } from './options.js';
import type { Style } from './config.js';
import { fail } from './config.js';

export type Layout = (input: TextLayoutInput) => Promise<TextLayout>;
function scalar(column: Column | undefined, row: number): number | null {
  if (!column) return null;
  if (column.kind === 'numeric') return numberAt(column, row);
  if (column.kind === 'boolean')
    return bitAt(column.validity, column.offset + row)
      ? +bitAt(column.values, column.offset + row)
      : null;
  fail('Expected a scalar numeric or boolean field');
}
function vector(column: Column | undefined, row: number): readonly [number, number] | null {
  if (!column) return null;
  if (column.kind !== 'vector' || column.size !== 2) fail('Expected a two-lane vector field');
  if (!bitAt(column.validity, column.offset + row)) return null;
  const at = (column.offset + row) * 2;
  const x = numberAt(column.values, at),
    y = numberAt(column.values, at + 1);
  return x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}
function text(column: Column | undefined, row: number): string {
  if (!column) return '';
  if (column.kind !== 'text') fail('Expected a text label field');
  return textAt(column, row) ?? '';
}
/** The fields a type's structure reads: what is drawn where, and its text. */
export function structure(option: VertexData | EdgeData): Record<string, FieldInput> {
  const out: Record<string, FieldInput> = {};
  if (option.visible) out.visible = option.visible;
  if (option.labels) out.label = option.labels.field;
  if ('position' in option && option.position) {
    if (typeof option.position === 'object' && 'x' in option.position) {
      out.x = option.position.x;
      out.y = option.position.y;
    } else out.position = option.position;
  }
  if ('size' in option && option.size) out.size = option.size;
  return out;
}
/** Whether a binding reads a sampled field, so it depends on the read coordinate. */
function sampled(data: DiagramData, type: string, input: FieldInput): boolean {
  return typeof input === 'string'
    ? data.source.schema.types[type]?.fields[input]?.sampled === true
    : 'source' in input &&
        input.source.schema.types[input.from]?.fields[input.field]?.sampled === true;
}
/** Only sampled geometry, visibility, and text invalidate the scene. */
export function sampledStructure(data: DiagramData): boolean {
  return [...Object.entries(data.vertices), ...Object.entries(data.edges ?? {})].some(
    ([type, options]) =>
      Object.values(structure(options)).some((input) => sampled(data, type, input)),
  );
}
/** What a scene is made of in each entry; every other option is a style the GPU reads. */
const VERTEX = [
  'rows',
  'position',
  'size',
  'shape',
  'cornerRadius',
  'labelPosition',
  'visible',
  'labels',
] as const satisfies readonly (keyof VertexData)[];
const PORT = ['side', 'order', 'marker', 'label'] as const satisfies readonly (keyof PortData)[];
const EDGE = [
  'rows',
  'ends',
  'route',
  'arrows',
  'appearance',
  'visible',
  'labels',
] as const satisfies readonly (keyof EdgeData)[];
/** Whether two diagrams have one structure, so only styles changed between them. */
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
  for (const [type, option] of [
    ...Object.entries(data.vertices),
    ...Object.entries(data.edges ?? {}),
  ] as const)
    for (const input of Object.values(structure(option))) add(type, input);
  return (type, definition) => [
    ...(named.get(type) ?? []),
    ...Object.keys(definition.fields).filter((field) => {
      const kind = definition.fields[field].type;
      return typeof kind === 'object' && kind.kind === 'reference';
    }),
  ];
}
/** Whether the structure reads only the drawn source, so its tables say when it changed. */
export function local(data: DiagramData): boolean {
  return [...Object.values(data.vertices), ...Object.values(data.edges ?? {})].every((option) =>
    Object.values(structure(option)).every((input) => typeof input === 'string'),
  );
}
interface Values {
  [name: string]: number | null;
}
function values(tile: FieldsBlock, row: number, names: readonly string[]): Values {
  return Object.fromEntries(
    names.map((name) => [
      name,
      tile.presence[name] && !bitAt(tile.presence[name], row)
        ? null
        : scalar(tile.columns[name], row),
    ]),
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
    size: config?.size ?? defaults.size ?? options.fontSizePx,
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
    const aliases = structure(option);
    const numeric = Object.keys(aliases).filter((k) => !['label', 'position', 'size'].includes(k));
    const rows = new Map<number, number>();
    byType.set(type, rows);
    for await (const tile of reader.fields({
      source: data.source,
      from: type,
      rows: option.rows,
      fields: aliases,
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
        const vals = values(tile, i, numeric);
        const xy = aliases.position
          ? !tile.presence.position || bitAt(tile.presence.position, i)
            ? vector(tile.columns.position, i)
            : null
          : vals.x !== null && vals.y !== null && Number.isFinite(vals.x) && Number.isFinite(vals.y)
            ? ([vals.x!, vals.y!] as const)
            : null;
        const size =
          !tile.presence.size || bitAt(tile.presence.size, i) ? vector(tile.columns.size, i) : null;
        if (size && (size[0] <= 0 || size[1] <= 0)) fail('Vertex size must be positive');
        const shown = vals.visible === undefined || vals.visible === null || vals.visible !== 0;
        texts.push(text(tile.columns.label, i));
        const vertex: Vertex = {
          hit: { kind: 'vertex', id, source: data.source, index: tile.index, row },
          index: tile.index,
          row,
          x: xy?.[0] ?? 0,
          y: xy?.[1] ?? 0,
          width: size?.[0] ?? 0,
          height: size?.[1] ?? 0,
          header: 0,
          pinned: !!xy,
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
    const maxCount = option.labels?.maxCount ?? Infinity;
    for (let i = start; i < scene.vertices.length; i++) {
      const vertex = scene.vertices[i];
      if (i - start < maxCount)
        vertex.label = await label(texts[i - start], option.labels, options, layout, title);
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
    const aliases = structure(option),
      numeric = Object.keys(aliases).filter((k) => k !== 'label');
    for await (const tile of reader.fields({
      source: data.source,
      from: type,
      rows: option.rows,
      fields: aliases,
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
        const v = values(tile, i, numeric),
          row = rowAt(tile.rows, i),
          id = textAt(tile.ids, i);
        if (id === null || edgeRows.has(row)) fail('Missing or duplicate edge identity');
        texts.push(text(tile.columns.label, i));
        const edge: Edge = {
          hit: { kind: 'edge', id, source: data.source, index: tile.index, row },
          ends: [],
          visible: v.visible === undefined || v.visible === null || v.visible !== 0,
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
    const maxCount = option.labels?.maxCount ?? Infinity;
    for (let i = start; i < Math.min(scene.edges.length, start + maxCount); i++) {
      scene.edges[i].label = await label(texts[i - start], option.labels, options, layout, {
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
