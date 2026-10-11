/**
 * Square lattices of buses over most of the globe: the stress cases, past any synthetic case in
 * size. Each bus joins its right and lower neighbours, and a few lines span the whole box as great
 * circles. Built in time linear in the bus count.
 */
import { createData, type Data, type Index, type Schema } from '@latkit/model';
import { numeric, references, rows, vector } from '../shared/columns.js';

export interface Lattice {
  readonly data: Data;
  readonly buses: number;
  readonly lines: number;
}
interface Spec {
  readonly cols: number;
  readonly rows: number;
  readonly lon: readonly [number, number];
  readonly lat: readonly [number, number];
  /** Lines across the box, as [column, row] to [column, row]. */
  readonly spans: readonly (readonly [number, number, number, number])[];
}
export const LATTICES: Readonly<Record<string, Spec>> = {
  'lattice-100k': {
    cols: 400,
    rows: 250,
    lon: [-160, 160],
    lat: [-80, 80],
    spans: [
      [0, 0, 399, 249],
      [399, 0, 0, 249],
      [0, 125, 399, 125],
      [200, 0, 200, 249],
    ],
  },
  'lattice-1m': {
    cols: 1000,
    rows: 1000,
    lon: [-170, 170],
    lat: [-75, 75],
    spans: [
      [0, 0, 999, 999],
      [999, 0, 0, 999],
    ],
  },
};
const schema: Schema = {
  types: {
    Bus: {
      fields: {
        position: { type: { kind: 'vector', size: 2, items: 'float32' }, geographic: true },
        /** Distance from the box's center, over the farthest: what the lattice colors by. */
        load: { type: 'float32' },
      },
    },
    Line: {
      fields: {
        from: { type: { kind: 'reference', to: 'Bus' } },
        to: { type: { kind: 'reference', to: 'Bus' } },
      },
    },
  },
};

export function lattice(id: string): Lattice {
  const spec = LATTICES[id];
  if (!spec) throw new Error(`No lattice ${id}`);
  const { cols, spans } = spec,
    count = cols * spec.rows,
    [west, east] = spec.lon,
    [south, north] = spec.lat,
    position = new Float32Array(count * 2),
    load = new Float32Array(count),
    at = (c: number, r: number) => r * cols + c;
  let farthest = 1e-6;
  for (let r = 0; r < spec.rows; r++)
    for (let c = 0; c < cols; c++) {
      const v = at(c, r),
        x = west + ((east - west) * c) / (cols - 1),
        y = south + ((north - south) * r) / (spec.rows - 1);
      position[v * 2] = x;
      position[v * 2 + 1] = y;
      load[v] = Math.hypot(x - (west + east) / 2, y - (south + north) / 2);
      farthest = Math.max(farthest, load[v]!);
    }
  for (let v = 0; v < count; v++) load[v]! /= farthest;
  const lines = spec.rows * (cols - 1) + cols * (spec.rows - 1) + spans.length,
    from = new Uint32Array(lines),
    to = new Uint32Array(lines);
  let e = 0;
  for (let r = 0; r < spec.rows; r++)
    for (let c = 0; c + 1 < cols; c++) {
      from[e] = at(c, r);
      to[e++] = at(c + 1, r);
    }
  for (let r = 0; r + 1 < spec.rows; r++)
    for (let c = 0; c < cols; c++) {
      from[e] = at(c, r);
      to[e++] = at(c, r + 1);
    }
  for (const [c0, r0, c1, r1] of spans) {
    from[e] = at(c0, r0);
    to[e++] = at(c1, r1);
  }
  const index = (type: string): Index => ({ source: id, type, version: '1' });
  return {
    data: createData(schema, [
      rows(index('Bus'), count, { position: vector(position), load: numeric(load) }),
      rows(index('Line'), lines, {
        from: references(index('Bus'), from),
        to: references(index('Bus'), to),
      }),
    ]),
    buses: count,
    lines,
  };
}
