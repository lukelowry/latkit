import { Work } from './work.js';
import { assertIndex, bitAt, numberAt, textAt, rowAt, rowCount } from '@latkit/model';
import type { Column, FieldDefinition, Index, Schema } from '@latkit/model';
import { GpuError, colormaps, kit, type RGBA } from '@latkit/gpu';
import type { DiagramData, VertexData, EdgeData, Labels } from './data.js';
import type { Reader, Scene, Vertex, Edge, Label, Port } from './scene.js';
import { emptyLabel } from './scene.js';
import type { Limits } from './options.js';
import type { Style } from './config.js';
import { fail, sources } from './config.js';

export type Measure = (
  input: kit.TextInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<kit.TextMetrics>;
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
function fields(option: VertexData | EdgeData): Record<string, kit.FieldInput> {
  const out: Record<string, kit.FieldInput> = {};
  for (const key of ['color', 'status', 'width', 'flow'] as const) {
    const scale = (option as VertexData & EdgeData)[key];
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
function values(tile: kit.NativeFields, row: number, names: readonly string[]): Values {
  return Object.fromEntries(
    names.map((name) => [
      name,
      tile.presence[name] && !bitAt(tile.presence[name], row)
        ? null
        : scalar(tile.columns[name], row),
    ]),
  );
}
function mapped(raw: number | null, scale: kit.ResolvedScale | undefined): number | null {
  return scale ? kit.scaleValue(raw ?? null, scale) : null;
}
function color(
  raw: number | null,
  config: kit.ColorScale | null | undefined,
  scale: kit.ResolvedScale | undefined,
  fallback: RGBA,
): RGBA {
  const t = mapped(raw, scale);
  return t === null ? fallback : kit.sampleColormap(config?.colormap ?? colormaps.grays, t);
}
async function scales(
  reader: Reader,
  data: DiagramData,
  type: string,
  option: VertexData | EdgeData,
): Promise<Map<string, kit.ResolvedScale>> {
  const bindings = new Map<string, kit.Scale | kit.ColorScale>();
  for (const name of ['color', 'status', 'width', 'flow'] as const) {
    const value = (option as VertexData & EdgeData)[name];
    if (value) bindings.set(name, value);
  }
  if ('ports' in option)
    for (const [name, port] of Object.entries(option.ports ?? {})) {
      if (port.color) bindings.set('port-color:' + name, port.color);
      if (port.status) bindings.set('port-status:' + name, port.status);
    }
  const result = new Map<string, kit.ResolvedScale>();
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
  options: Style,
  measure: Measure,
  signal: AbortSignal,
): Promise<Label> {
  if (!textValue) return emptyLabel;
  const font: kit.TextFont = config?.font ?? options.font,
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
  const runs: kit.TextRun[] = [];
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
  options: Style,
  limits: Required<Limits>,
  measure: Measure,
  work = new Work(reader.signal, limits.prepareMs),
): Promise<Scene> {
  const versions = new Map([...sources(data)].map((source) => [source, source.version]));
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
    versions,
  };
  let schema: Schema | undefined;
  // A schema-only read pins the authoritative topology schema for this preparation.
  const firstType = Object.keys(data.vertices)[0] ?? Object.keys(data.edges ?? {})[0];
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
  const reference = (field: FieldDefinition | undefined) =>
    field && typeof field.type === 'object' && field.type.kind === 'reference'
      ? field.type.to
      : undefined;
  const nets = new Set(
    Object.entries(data.edges ?? {})
      .filter(([, edge]) => !edge.ends)
      .map(([type]) => type),
  );
  /** Each port wired to a net row: its vertex and port, by net type. */
  const wired = new Map<
    string,
    { index?: Index; vertex: number[]; port: string[]; row: number[] }
  >();
  for (const type of nets) wired.set(type, { vertex: [], port: [], row: [] });
  for (const [type, option] of Object.entries(data.vertices)) {
    const definition = schema.types[type];
    if (!definition) fail('Unknown vertex type: ' + type);
    // A port is a reference field naming a drawn net.
    const ports = Object.entries(definition.fields).filter(([, field]) => {
      const to = reference(field);
      return to !== undefined && nets.has(to);
    });
    for (const name of Object.keys(option.ports ?? {}))
      if (!ports.some(([port]) => port === name)) fail('Unknown port: ' + type + '.' + name);
    const start = scene.vertices.length,
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
      if (!tile.ids) fail('Vertex IDs were not returned');
      await work.step();
      for (let i = 0; i < rowCount(tile.rows); i++) {
        check();
        if (scene.vertices.length >= limits.vertices)
          throw new GpuError('resource-limit', 'Too many diagram vertices');
        charge(512 + ports.length * 192);
        const row = rowAt(tile.rows, i);
        if (rows.has(row)) fail('Duplicate vertex row');
        const id = textAt(tile.ids, i);
        if (id === null) fail('Missing vertex identity');
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
        if (size && (size[0] <= 0 || size[1] <= 0)) fail('Vertex size must be positive');
        const vertex: Vertex = {
          hit: { kind: 'vertex', id, type, source: data.source, index: tile.index, row },
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
          color: options.vertexBaseColor,
          shade: Number.isFinite(vals.shade) ? vals.shade! : 1,
          label: { ...emptyLabel, text: text(tile.columns.label, i) },
          ports: [],
          options: option,
        };
        for (const [name, field] of ports) {
          const p = option.ports?.[name];
          vertex.ports.push({
            name,
            to: reference(field)!,
            ...(field.direction ? { direction: field.direction } : {}),
            marker: p?.marker ?? options.portMarker,
            connected: false,
            order: p?.order ?? vertex.ports.length,
            side: p?.side ?? (field.direction === 'in' ? 'left' : 'right'),
            label: { ...emptyLabel, text: p?.label ?? field.label ?? name },
            color: options.edgeBaseColor,
            position: [0, 0],
            normal: [0, 0],
          });
        }
        rows.set(row, scene.vertices.length);
        scene.vertices.push(vertex);
      }
    }
    if (ports.length)
      for await (const block of reader.query(data.source, {
        kind: 'rows',
        from: type,
        rows: option.rows,
        select: ports.map(([name]) => name),
      })) {
        if (block.kind === 'schema') continue;
        await work.step();
        const columns = ports.map(([name, field]) => {
          const column = block.columns[name];
          if (column?.kind !== 'reference') fail('Expected a reference column: ' + name);
          const net = wired.get(reference(field)!)!;
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
    const columns = await scales(reader, data, type, option);
    for (let i = start; i < scene.vertices.length; i++) {
      const vertex = scene.vertices[i],
        v = raw[i - start];
      vertex.color = color(v.color, option.color, columns.get('color'), options.vertexBaseColor);
      if (option.status && v.status !== null)
        vertex.status = color(v.status, option.status, columns.get('status'), vertex.color);
      if (i - start < (option.labels?.maxCount ?? Infinity))
        vertex.label = await label(
          vertex.label.text,
          option.labels,
          options,
          measure,
          reader.signal,
        );
      else vertex.label = emptyLabel;
      for (const port of vertex.ports) {
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
        port.color = color(v[c], config?.color, columns.get(c), options.edgeBaseColor);
        if (config?.status && v[s] !== null)
          port.status = color(v[s], config.status, columns.get(s), port.color);
      }
      const side = (name: Port['side']) => vertex.ports.filter((p) => p.side === name);
      const textWidth = (ports: Port[]) => ports.reduce((m, p) => Math.max(m, p.label.width), 0);
      const horizontal = Math.max(side('top').length, side('bottom').length) * options.portSpacing;
      const vertical = Math.max(side('left').length, side('right').length) * options.portSpacing;
      const centered = option.labelPosition !== 'header';
      const shapeScale =
        vertex.shape === 'diamond' ? 2 : vertex.shape === 'ellipse' ? Math.SQRT2 : 1;
      const autoWidth = !vertex.width,
        autoHeight = !vertex.height;
      vertex.width ||= Math.max(
        96,
        (vertex.label.width + options.vertexPadding * 2) * shapeScale,
        textWidth(side('left')) +
          textWidth(side('right')) +
          options.vertexPadding * 3 +
          (centered ? vertex.label.width + options.vertexPadding : 0),
        horizontal + options.vertexPadding * 2,
      );
      vertex.header = centered
        ? 0
        : vertex.label.height +
          options.vertexPadding * 2 +
          (side('top').length ? options.fontSizePx * 1.5 : 0);
      vertex.height ||=
        shapeScale *
        Math.max(
          40,
          vertex.label.height + options.vertexPadding * 2,
          vertex.header +
            Math.max(vertical, options.portSpacing) +
            options.vertexPadding +
            (side('bottom').length ? options.fontSizePx * 1.5 : 0),
        );
      if (autoWidth) {
        if (vertex.shape === 'ellipse') vertex.width = Math.max(vertex.width, vertex.height * 1.4);
        if (vertex.shape === 'diamond') vertex.width = Math.max(vertex.width, vertex.height * 1.25);
        vertex.width = Math.ceil(vertex.width / options.gridPitch) * options.gridPitch;
      }
      if (autoHeight)
        vertex.height = Math.ceil(vertex.height / options.gridPitch) * options.gridPitch;
      charge(vertex.label.text.length * 2 + vertex.label.runs.length * 128);
      check();
    }
  }
  const end = (edge: Edge, vertex: number, port: string | null, direction?: 'in' | 'out') => {
    if (++scene.ends > limits.ends) throw new GpuError('resource-limit', 'Too many edge ends');
    charge(48);
    edge.ends.push({ vertex, port, ...(direction ? { direction } : {}) });
  };
  for (const [type, option] of Object.entries(data.edges ?? {})) {
    const definition = schema.types[type];
    if (!definition) fail('Unknown edge type: ' + type);
    const targets = option.ends?.map((name) => {
      const to = reference(definition.fields[name]);
      if (to === undefined || !byType.has(to))
        fail('Edge end ' + type + '.' + name + ' must reference a vertex type');
      return to;
    });
    const raw: Values[] = [],
      edgeRows = new Map<number, Edge>(),
      start = scene.edges.length;
    let index: Index | undefined;
    const aliases = fields(option),
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
          throw new GpuError('resource-limit', 'Too many diagram edges');
        charge(384);
        const v = values(tile, i, numeric),
          row = rowAt(tile.rows, i),
          id = textAt(tile.ids, i);
        if (id === null || edgeRows.has(row)) fail('Missing or duplicate edge identity');
        raw.push(v);
        const edge: Edge = {
          hit: { kind: 'edge', type, id, source: data.source, index: tile.index, row },
          ends: [],
          visible: v.visible === undefined || v.visible === null || v.visible !== 0,
          color: options.edgeBaseColor,
          width: options.edgeWidthPx,
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
    if (option.ends && targets) {
      // A row's own ends, ordered source to target.
      for await (const block of reader.query(data.source, {
        kind: 'rows',
        from: type,
        rows: option.rows,
        select: [...option.ends],
      })) {
        if (block.kind === 'schema') continue;
        await work.step();
        const columns = option.ends.map((name) => {
          const column = block.columns[name];
          if (column?.kind !== 'reference') fail('Expected a reference column: ' + name);
          return column;
        });
        for (let i = 0; i < rowCount(block.rows); i++) {
          check();
          const edge = edgeRows.get(rowAt(block.rows, i));
          if (!edge) fail('Ends name an unselected edge row');
          columns.forEach((column, side) => {
            const at = column.offset + i;
            if (!bitAt(column.validity, at)) return;
            const vertex = byType.get(targets[side])!.get(column.values[at]);
            if (vertex !== undefined) end(edge, vertex, null, side ? 'in' : 'out');
          });
        }
      }
    } else {
      const net = wired.get(type)!;
      if (
        !Object.keys(data.vertices).some((vertex) =>
          Object.values(schema.types[vertex].fields).some((field) => reference(field) === type),
        )
      )
        fail('No vertex type references net ' + type);
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
    const resolved = await scales(reader, data, type, option);
    for (let i = start; i < scene.edges.length; i++) {
      const edge = scene.edges[i],
        v = raw[i - start];
      edge.color = color(v.color, option.color, resolved.get('color'), options.edgeBaseColor);
      edge.width = Math.max(0, mapped(v.width, resolved.get('width')) ?? options.edgeWidthPx);
      edge.flow = mapped(v.flow, resolved.get('flow')) ?? 0;
      edge.label =
        i - start < (option.labels?.maxCount ?? Infinity)
          ? await label(edge.label.text, option.labels, options, measure, reader.signal)
          : emptyLabel;
    }
  }
  for (const [id, group] of Object.entries(data.groups ?? {})) {
    const members: number[] = [];
    for (const [type, selection] of Object.entries(group.vertices)) {
      if (!byType.has(type)) fail('Unknown group vertex type: ' + type);
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
