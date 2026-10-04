import { bitAt, rowAt, rowCount, type FieldInput, type ReadScope, type Work } from '@latkit/model';
import { colormaps, kit, type ColorScale, type RGBA, type Scale } from '@latkit/gpu';
import type { DiagramData, VertexData, EdgeData } from './data.js';
import type { Scene } from './scene.js';
import { scalar, sampled } from './read.js';

/** Negative alpha selects the view's current base color in the shader. */
const VERTEX: RGBA = [0, 0, 0, -1];
const EDGE: RGBA = [1, 0, 0, -1];
const CLEAR: RGBA = [0, 0, 0, 0];
export interface ItemValues {
  readonly color: RGBA;
  readonly status: RGBA;
  /** Negative means the view's current edgeWidthPx. */
  readonly width: number;
  readonly flow: number;
  readonly shade: number;
}
const vertex: ItemValues = { color: VERTEX, status: CLEAR, width: -1, flow: 0, shade: 1 };
const edge: ItemValues = { ...vertex, color: EDGE };

/** Owned CPU values: no reader blocks, frame bindings, or borrowed GPU resources. */
export interface Values {
  readonly items: readonly ItemValues[];
  readonly maxWidth: number;
  readonly flowing: boolean;
  readonly bytes: number;
}

function mappings(options: VertexData | EdgeData): Map<string, Scale | ColorScale> {
  const result = new Map<string, Scale | ColorScale>();
  for (const name of ['color', 'status', 'widthPx', 'flow'] as const) {
    const mapping = (options as VertexData & EdgeData)[name];
    if (mapping) result.set(name, mapping);
  }
  if ('ports' in options)
    for (const [name, port] of Object.entries(options.ports ?? {})) {
      if (port.color) result.set('port-color:' + name, port.color);
      if (port.status) result.set('port-status:' + name, port.status);
    }
  return result;
}
function fields(options: VertexData | EdgeData): Record<string, FieldInput> {
  const result = Object.fromEntries(
    [...mappings(options)].map(([name, scale]) => [name, scale.field]),
  );
  if (options.shade) result.shade = options.shade;
  return result;
}
export function sampledValues(data: DiagramData): boolean {
  return [...Object.entries(data.vertices), ...Object.entries(data.edges ?? {})].some(
    ([type, options]) => Object.values(fields(options)).some((input) => sampled(data, type, input)),
  );
}

export async function readValues(
  scene: Scene,
  data: DiagramData,
  reader: ReadScope,
  work: Work,
): Promise<Values> {
  const items = new Array<ItemValues>(scene.slots.count).fill(vertex);
  items.fill(edge, scene.slots.ports, scene.slots.groups);
  let maxWidth = 0,
    flowing = false,
    allocated = 0;
  const groups = new Map<string, { options: VertexData | EdgeData; rows: Map<number, number> }>();
  scene.vertices.forEach((item, slot) => {
    const key = 'v:' + item.index.type;
    let group = groups.get(key);
    if (!group)
      groups.set(key, (group = { options: data.vertices[item.index.type], rows: new Map() }));
    group.rows.set(item.row, slot);
  });
  scene.edges.forEach((item, index) => {
    const key = 'e:' + item.hit.index.type;
    let group = groups.get(key);
    if (!group)
      groups.set(key, (group = { options: data.edges![item.hit.index.type], rows: new Map() }));
    group.rows.set(item.hit.row, scene.slots.edges + index);
  });
  for (const [key, { options, rows }] of groups) {
    reader.signal.throwIfAborted();
    const isEdge = key.startsWith('e:'),
      type = key.slice(2),
      inputs = fields(options);
    const base = options.baseColor ?? (isEdge ? EDGE : VERTEX);
    const defaults: ItemValues = { ...vertex, color: base };
    for (const slot of rows.values()) items[slot] = defaults;
    if (!Object.keys(inputs).length) continue;
    const mapped = mappings(options),
      scales = new Map<string, kit.ResolvedScale>();
    for (const [name, mapping] of mapped)
      scales.set(
        name,
        await kit.fieldScale(reader, {
          ...mapping,
          source: data.source,
          from: type,
          rows: options.rows,
          range:
            ('range' in mapping ? mapping.range : undefined) ??
            (name === 'widthPx' ? [1, 4] : name === 'flow' ? [0, 40] : [0, 1]),
        }),
      );
    for await (const tile of reader.fields({
      source: data.source,
      from: type,
      rows: options.rows,
      fields: inputs,
    })) {
      for (let row = 0; row < rowCount(tile.rows); row++) {
        if ((row & 1023) === 0) await work.step();
        const slot = rows.get(rowAt(tile.rows, row));
        if (slot === undefined) continue;
        const raw = (name: string) =>
          bitAt(tile.presence[name], row) ? scalar(tile.columns[name], row) : null;
        const scaled = (name: string) => {
          const scale = scales.get(name);
          return scale ? kit.scaleValue(raw(name), scale) : null;
        };
        const color = (name: string, fallback: RGBA): RGBA => {
          const value = scaled(name);
          return value === null
            ? fallback
            : kit.sampleColormap(
                (mapped.get(name) as ColorScale | undefined)?.colormap ?? colormaps.grays,
                value,
              );
        };
        const shade = raw('shade'),
          width = scaled('widthPx');
        const value: ItemValues = {
          color: color('color', base),
          status: color('status', CLEAR),
          width: width === null ? -1 : Math.max(0, width),
          flow: scaled('flow') ?? 0,
          shade: shade !== null && Number.isFinite(shade) ? shade : 1,
        };
        items[slot] = value;
        allocated++;
        if (isEdge) {
          maxWidth = Math.max(maxWidth, value.width);
          flowing ||= scene.edges[slot - scene.slots.edges].visible && value.flow !== 0;
        } else {
          const item = scene.vertices[slot];
          item.ports.forEach((port, index) => {
            items[item.portSlot + index] = {
              ...edge,
              color: color('port-color:' + port.name, EDGE),
              status: color('port-status:' + port.name, CLEAR),
              shade: value.shade,
            };
            allocated++;
          });
        }
      }
    }
  }
  return { items, maxWidth, flowing, bytes: items.length * 8 + allocated * 128 };
}
