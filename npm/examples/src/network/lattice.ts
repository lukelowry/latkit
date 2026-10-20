/**
 * Square lattices of buses over most of the globe: the stress cases, past any synthetic case in
 * size. Each bus joins its right and lower neighbours, and a few lines span the whole box as great
 * circles. Built in time linear in the bus count.
 */
import { Data, Patch, reference, type Fit } from '../latkit.js';

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

/** The lattice `id` as dataset `grid`, buses colored by their distance from the box's middle, and
 * the box. */
export function lattice(id: string): { data: Data; buses: number; lines: number; bounds: Fit } {
  const spec = LATTICES[id];
  if (!spec) throw new Error(`No lattice ${id}`);
  const { cols, spans } = spec;
  const count = cols * spec.rows;
  const [west, east] = spec.lon;
  const [south, north] = spec.lat;
  const lon = new Float64Array(count);
  const lat = new Float64Array(count);
  const load = new Float32Array(count);
  const at = (c: number, r: number) => r * cols + c;
  let farthest = 1e-6;
  for (let r = 0; r < spec.rows; r++)
    for (let c = 0; c < cols; c++) {
      const v = at(c, r);
      lon[v] = west + ((east - west) * c) / (cols - 1);
      lat[v] = south + ((north - south) * r) / (spec.rows - 1);
      load[v] = Math.hypot(lon[v]! - (west + east) / 2, lat[v]! - (south + north) / 2);
      farthest = Math.max(farthest, load[v]!);
    }
  for (let v = 0; v < count; v++) load[v]! /= farthest;
  const lines = spec.rows * (cols - 1) + cols * (spec.rows - 1) + spans.length;
  const from = new Uint32Array(lines);
  const to = new Uint32Array(lines);
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
  const data = new Data('grid').apply(
    new Patch()
      .set('Bus', { count }, { lon, lat, load })
      .set('Line', { count: lines }, { from: reference('Bus', from), to: reference('Bus', to) }),
  );
  return {
    data,
    buses: count,
    lines,
    bounds: { bounds: { min: [west, south, 0], max: [east, north, 0] } },
  };
}
