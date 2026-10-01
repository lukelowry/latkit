import { Work } from './work.js';
import { assertIndex, bitAt, numberAt, textAt, rowAt, rowCount } from '@latkit/model';
import type { Column, Schema } from '@latkit/model';
import { GpuError, scaleValue, sampleColormap, colormaps } from '@latkit/gpu';
import type {
  FieldInput,
  ColorScale,
  Scale,
  RGBA,
  TextInput,
  TextMetrics,
  TextFont,
  NativeFields,
  ResolvedScale,
} from '@latkit/gpu';
import type { DiagramData, ComponentOptions, ConnectionOptions, Labels } from './data.js';
import type { Reader, Scene, Node, Edge, Label, Port } from './scene.js';
import { emptyLabel } from './scene.js';
import type { Options, Limits } from './options.js';
import { fail, sources } from './config.js';

export type Measure = (
  input: TextInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<TextMetrics>;
export function scalar(column: Column | undefined, row: number): number | null {
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
function fields(option: ComponentOptions | ConnectionOptions): Record<string, FieldInput> {
  const out: Record<string, FieldInput> = {};
  for (const key of ['color', 'status', 'width', 'flow'] as const) {
    const scale = (option as ComponentOptions & ConnectionOptions)[key];
    if (scale) out[key] = scale.field;
  }
  for (const key of ['visible', 'shade'] as const) if (option[key]) out[key] = option[key]!;
  if (option.labels) out.label = option.labels.field;
  if ('position' in option && option.position) {
    if (typeof option.position === 'object' && 'x' in option.position) {
      out.x = option.position.x;
      out.y = option.position.y;
    } else out.position = option.position;
  }
  if ('size' in option && option.size) out.size = option.size;
  if ('ports' in option)
    for (const [name, port] of Object.entries(option.ports ?? {})) {
      if (port.color) out['port-color:' + name] = port.color.field;
      if (port.status) out['port-status:' + name] = port.status.field;
    }
  return out;
}
interface Values {
  [name: string]: number | null;
}
function values(tile: NativeFields, row: number, names: readonly string[]): Values {
  return Object.fromEntries(
    names.map((name) => [
      name,
      tile.presence[name] && !bitAt(tile.presence[name], row)
        ? null
        : scalar(tile.columns[name], row),
    ]),
  );
}
function mapped(raw: number | null, scale: ResolvedScale | undefined): number | null {
  return scale ? scaleValue(raw ?? null, scale) : null;
}
function color(
  raw: number | null,
  config: ColorScale | null | undefined,
  scale: ResolvedScale | undefined,
  fallback: RGBA,
): RGBA {
  const t = mapped(raw, scale);
  return t === null ? fallback : sampleColormap(config?.colormap ?? colormaps.grays, t);
}
async function scales(
  reader: Reader,
  data: DiagramData,
  type: string,
  option: ComponentOptions | ConnectionOptions,
): Promise<Map<string, ResolvedScale>> {
  const bindings = new Map<string, Scale | ColorScale>();
  for (const name of ['color', 'status', 'width', 'flow'] as const) {
    const value = (option as ComponentOptions & ConnectionOptions)[name];
    if (value) bindings.set(name, value);
  }
  if ('ports' in option)
    for (const [name, port] of Object.entries(option.ports ?? {})) {
      if (port.color) bindings.set('port-color:' + name, port.color);
      if (port.status) bindings.set('port-status:' + name, port.status);
    }
  const result = new Map<string, ResolvedScale>();
  for (const [name, value] of bindings)
    result.set(
      name,
      await reader.scale({
        ...value,
        source: data.source,
        from: type,
        rows: option.rows,
        range:
          'range' in value
            ? value.range
            : name === 'width'
              ? [1, 4]
              : name === 'flow'
                ? [0, 40]
                : [0, 1],
      }),
    );
  return result;
}
export async function label(
  textValue: string,
  config: Labels | null | undefined,
  options: Required<Options>,
  measure: Measure,
  signal: AbortSignal,
): Promise<Label> {
  if (!textValue) return emptyLabel;
  const font: TextFont = config?.font ?? options.font,
    size = config?.size ?? options.fontSizePx;
  const metric = (s: string) => measure({ text: s, font }, { signal });
  const max = config?.maxWidth ?? Infinity;
  const lines: string[] = [];
  for (const line of textValue.split(/\r?\n/)) {
    if (max === Infinity || (await metric(line)).advance * size <= max) {
      lines.push(line);
      continue;
    }
    const chars = [...line];
    if (config?.overflow === 'wrap') {
      let current = '';
      for (const c of chars) {
        if (current && (await metric(current + c)).advance * size > max) {
          lines.push(current);
          current = '';
        }
        current += c;
      }
      lines.push(current);
    } else {
      let lo = 0,
        hi = chars.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((await metric(chars.slice(0, mid).join('') + '…')).advance * size <= max) lo = mid;
        else hi = mid - 1;
      }
      lines.push(chars.slice(0, lo).join('') + '…');
    }
  }
  let width = 0,
    height = 0,
    ascent = 0;
  const runs: import('@latkit/gpu').TextRun[] = [];
  for (const line of lines) {
    const m = await metric(line || ' ');
    const lineHeight = Math.max(size, (m.ascent + m.descent) * size);
    if (!runs.length) ascent = m.ascent * size;
    runs.push({
      text: line,
      font,
      size,
      color: config?.color ?? options.textColor,
      position: [0, height + m.ascent * size],
    });
    width = Math.max(width, m.advance * size);
    height += lineHeight * 1.2;
  }
  return { text: textValue, width, height, ascent, runs };
}
export async function readScene(
  data: DiagramData,
  reader: Reader,
  options: Required<Options>,
  limits: Required<Limits>,
  measure: Measure,
  work = new Work(reader.signal, limits.prepareMs),
): Promise<Scene> {
  const versions = new Map([...sources(data)].map((source) => [source, source.version]));
  const check = () => work.check();
  const scene: Scene = {
    data,
    nodes: [],
    edges: [],
    groups: [],
    bounds: [0, 0, 0, 0],
    bytes: 0,
    routeBytes: 0,
    endpoints: 0,
    versions,
  };
  let schema: Schema | undefined;
  // A schema-only read pins the authoritative topology schema for this preparation.
  const firstType = Object.keys(data.components)[0] ?? Object.keys(data.connections ?? {})[0];
  if (!firstType) return scene;
  for await (const block of reader.query(data.source, {
    kind: 'rows',
    from: firstType,
    select: [],
    rows: { kind: 'range', offset: 0, count: 0 },
  })) {
    if (block.kind === 'schema') schema = block.schema;
  }
  if (!schema) fail('Missing source schema');
  const charge = (bytes: number) => {
    scene.bytes += bytes;
    if (scene.bytes > limits.geometryBytes)
      throw new GpuError('resource-limit', 'Diagram geometry exceeds budget');
  };
  const byType = new Map<string, Map<number, number>>();
  for (const [type, option] of Object.entries(data.components)) {
    const definition = schema.components[type];
    if (!definition) fail('Unknown component type: ' + type);
    const start = scene.nodes.length,
      raw: Values[] = [];
    const aliases = fields(option);
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
      if (!tile.ids) fail('Component IDs were not returned');
      await work.step();
      for (let i = 0; i < rowCount(tile.rows); i++) {
        check();
        if (scene.nodes.length >= limits.components)
          throw new GpuError('resource-limit', 'Too many diagram components');
        charge(512 + Object.keys(definition.ports ?? {}).length * 192);
        const row = rowAt(tile.rows, i);
        if (rows.has(row)) fail('Duplicate component row');
        const id = textAt(tile.ids, i);
        if (id === null) fail('Missing component identity');
        const vals = values(tile, i, numeric);
        raw.push(vals);
        const xy = aliases.position
          ? !tile.presence.position || bitAt(tile.presence.position, i)
            ? vector(tile.columns.position, i)
            : null
          : vals.x !== null && vals.y !== null && Number.isFinite(vals.x) && Number.isFinite(vals.y)
            ? ([vals.x!, vals.y!] as const)
            : null;
        const size =
          !tile.presence.size || bitAt(tile.presence.size, i) ? vector(tile.columns.size, i) : null;
        if (size && (size[0] <= 0 || size[1] <= 0)) fail('Component size must be positive');
        const node: Node = {
          hit: { kind: 'component', id, type, source: data.source, index: tile.index, row },
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
          visible: vals.visible === undefined || vals.visible === null || vals.visible !== 0,
          sourceVisible: vals.visible === undefined || vals.visible === null || vals.visible !== 0,
          color: options.componentBaseColor,
          shade: Number.isFinite(vals.shade) ? vals.shade! : 1,
          label: { ...emptyLabel, text: text(tile.columns.label, i) },
          ports: [],
          options: option,
        };
        for (const [name, port] of Object.entries(definition.ports ?? {})) {
          const p = option.ports?.[name];
          node.ports.push({
            name,
            definition: port,
            marker: p?.marker ?? options.portMarker,
            connected: false,
            order: p?.order ?? node.ports.length,
            side: p?.side ?? (port.direction === 'in' ? 'left' : 'right'),
            label: { ...emptyLabel, text: p?.label ?? port.label ?? name },
            color: options.connectionBaseColor,
            position: [0, 0],
            normal: [0, 0],
          });
        }
        for (const name of Object.keys(option.ports ?? {}))
          if (!definition.ports?.[name]) fail('Unknown port: ' + type + '.' + name);
        rows.set(row, scene.nodes.length);
        scene.nodes.push(node);
      }
    }
    const columns = await scales(reader, data, type, option);
    for (let i = start; i < scene.nodes.length; i++) {
      const node = scene.nodes[i],
        v = raw[i - start];
      node.color = color(v.color, option.color, columns.get('color'), options.componentBaseColor);
      if (option.status && v.status !== null)
        node.status = color(v.status, option.status, columns.get('status'), node.color);
      if (i - start < (option.labels?.maxCount ?? Infinity))
        node.label = await label(node.label.text, option.labels, options, measure, reader.signal);
      else node.label = emptyLabel;
      for (const port of node.ports) {
        port.label = options.portLabels
          ? await label(
              port.label.text,
              null,
              { ...options, fontSizePx: options.portFontSizePx },
              measure,
              reader.signal,
            )
          : emptyLabel;
        const config = option.ports?.[port.name],
          c = 'port-color:' + port.name,
          s = 'port-status:' + port.name;
        port.color = color(v[c], config?.color, columns.get(c), options.connectionBaseColor);
        if (config?.status && v[s] !== null)
          port.status = color(v[s], config.status, columns.get(s), port.color);
      }
      const side = (name: Port['side']) => node.ports.filter((p) => p.side === name);
      const textWidth = (ports: Port[]) => ports.reduce((m, p) => Math.max(m, p.label.width), 0);
      const horizontal = Math.max(side('top').length, side('bottom').length) * options.portSpacing;
      const vertical = Math.max(side('left').length, side('right').length) * options.portSpacing;
      const centered = option.labelPosition !== 'header';
      const shapeScale = node.shape === 'diamond' ? 2 : node.shape === 'ellipse' ? Math.SQRT2 : 1;
      const autoWidth = !node.width,
        autoHeight = !node.height;
      node.width ||= Math.max(
        96,
        (node.label.width + options.nodePadding * 2) * shapeScale,
        textWidth(side('left')) +
          textWidth(side('right')) +
          options.nodePadding * 3 +
          (centered ? node.label.width + options.nodePadding : 0),
        horizontal + options.nodePadding * 2,
      );
      node.header = centered
        ? 0
        : node.label.height +
          options.nodePadding * 2 +
          (side('top').length ? options.fontSizePx * 1.5 : 0);
      node.height ||=
        shapeScale *
        Math.max(
          40,
          node.label.height + options.nodePadding * 2,
          node.header +
            Math.max(vertical, options.portSpacing) +
            options.nodePadding +
            (side('bottom').length ? options.fontSizePx * 1.5 : 0),
        );
      if (autoWidth) {
        if (node.shape === 'ellipse') node.width = Math.max(node.width, node.height * 1.4);
        if (node.shape === 'diamond') node.width = Math.max(node.width, node.height * 1.25);
        node.width = Math.ceil(node.width / options.gridPitch) * options.gridPitch;
      }
      if (autoHeight) node.height = Math.ceil(node.height / options.gridPitch) * options.gridPitch;
      charge(node.label.text.length * 2 + node.label.runs.length * 128);
      check();
    }
  }
  for (const [type, option] of Object.entries(data.connections ?? {})) {
    const definition = schema.connections[type];
    if (!definition) fail('Unknown connection type: ' + type);
    if (!schema.queries.includes('endpoints')) fail('Source must support endpoint queries');
    const raw: Values[] = [],
      edgeRows = new Map<number, Edge>(),
      start = scene.edges.length;
    const aliases = fields(option),
      numeric = Object.keys(aliases).filter((k) => k !== 'label');
    for await (const tile of reader.fields({
      source: data.source,
      from: type,
      rows: option.rows,
      fields: aliases,
      ids: true,
    })) {
      if (!tile.ids) fail('Connection IDs were not returned');
      await work.step();
      for (let i = 0; i < rowCount(tile.rows); i++) {
        check();
        if (scene.edges.length >= limits.connections)
          throw new GpuError('resource-limit', 'Too many connections');
        charge(384);
        const v = values(tile, i, numeric),
          row = rowAt(tile.rows, i),
          id = textAt(tile.ids, i);
        if (id === null || edgeRows.has(row)) fail('Missing or duplicate connection identity');
        raw.push(v);
        const edge: Edge = {
          hit: { kind: 'connection', type, id, source: data.source, index: tile.index, row },
          endpoints: [],
          visible: v.visible === undefined || v.visible === null || v.visible !== 0,
          color: options.connectionBaseColor,
          width: options.connectionWidthPx,
          flow: 0,
          shade: Number.isFinite(v.shade) ? v.shade! : 1,
          label: { ...emptyLabel, text: text(tile.columns.label, i) },
          options: option,
          paths: [],
          offsets: [],
          labelBounds: [],
          arrows: [],
          junctions: [],
          anchor: [0, 0],
          bounds: [0, 0, 0, 0],
        };
        edgeRows.set(row, edge);
        scene.edges.push(edge);
      }
    }
    let active: { row: number; next: number; total: number } | undefined;
    const completed = new Set<number>();
    for await (const block of reader.query(data.source, {
      kind: 'endpoints',
      from: type,
      rows: option.rows,
    })) {
      if (block.kind === 'schema') continue;
      await work.step();
      for (let c = 0; c < block.connections.length; c++) {
        check();
        const row = block.connections[c],
          edge = edgeRows.get(row),
          first = block.firstEndpoint[c],
          total = block.totalEndpoints[c];
        if (!edge) fail('Endpoints reference an unselected connection');
        assertIndex(edge.hit.index, block.index);
        if (!active) {
          if (completed.has(row) || first !== 0) fail('Duplicate or incomplete endpoint sequence');
          active = { row, next: 0, total };
        }
        if (active.row !== row || active.next !== first || active.total !== total)
          fail('Invalid endpoint sequence');
        const begin = block.offsets[c],
          end = block.offsets[c + 1];
        if (
          begin < 0 ||
          end < begin ||
          end > block.componentRow.length ||
          first + end - begin > total
        )
          fail('Invalid endpoint offsets');
        for (let e = begin; e < end; e++) {
          if (++scene.endpoints > limits.endpoints)
            throw new GpuError('resource-limit', 'Too many endpoints');
          charge(48);
          const index = block.componentIndexes[block.componentType[e]];
          if (!index) fail('Invalid endpoint component dictionary');
          const nodeIndex = byType.get(index.type)?.get(block.componentRow[e]);
          const port = block.portNames[block.port[e]],
            role = block.roleNames[block.role[e]];
          if (port === undefined || role === undefined || !definition.roles[role])
            fail('Invalid endpoint dictionary');
          if (nodeIndex !== undefined) {
            const node = scene.nodes[nodeIndex];
            assertIndex(node.index, index);
            if (port !== null && !node.ports.some((p) => p.name === port))
              fail('Unknown endpoint port');
            const anchor = node.ports.find((p) => p.name === port);
            if (anchor) anchor.connected = true;
            edge.endpoints.push({
              node: nodeIndex,
              port,
              role,
              ordinal: first + e - begin,
              direction: definition.roles[role].direction,
            });
          }
        }
        active.next += end - begin;
        if (active.next === total) {
          completed.add(row);
          active = undefined;
        }
      }
    }
    if (active || completed.size !== edgeRows.size) fail('Incomplete connection endpoints');
    const resolved = await scales(reader, data, type, option);
    for (let i = start; i < scene.edges.length; i++) {
      const edge = scene.edges[i],
        v = raw[i - start];
      edge.color = color(v.color, option.color, resolved.get('color'), options.connectionBaseColor);
      edge.width = Math.max(0, mapped(v.width, resolved.get('width')) ?? options.connectionWidthPx);
      edge.flow = mapped(v.flow, resolved.get('flow')) ?? 0;
      edge.label =
        i - start < (option.labels?.maxCount ?? Infinity)
          ? await label(edge.label.text, option.labels, options, measure, reader.signal)
          : emptyLabel;
    }
  }
  for (const [id, group] of Object.entries(data.groups ?? {})) {
    const members: number[] = [];
    for (const [type, selection] of Object.entries(group.components)) {
      if (!schema.components[type]) fail('Unknown group component type: ' + type);
      for await (const block of reader.query(data.source, {
        kind: 'rows',
        from: type,
        rows: selection,
        select: [],
      })) {
        if (block.kind === 'schema') continue;
        await work.step();
        for (let at = 0; at < rowCount(block.rows); at++) {
          const i = byType.get(type)?.get(rowAt(block.rows, at));
          if (i === undefined) continue;
          const node = scene.nodes[i];
          assertIndex(node.index, block.index);
          if (node.group) fail('A component may belong to only one direct group');
          node.group = id;
          members.push(i);
          charge(8);
        }
      }
    }
    charge(256 + (group.label?.length ?? id.length) * 2);
    scene.groups.push({
      id,
      label: await label(group.label ?? id, null, options, measure, reader.signal),
      bounds: [0, 0, 0, 0],
      collapsed: group.collapsed ?? false,
      members,
      parent: group.parent,
    });
  }
  for (const [source, version] of versions)
    if (source.version !== version)
      throw new GpuError('conflict', 'Diagram source changed during preparation');
  return scene;
}
