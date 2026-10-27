/**
 * The scenarios' data, made before anything is measured. It is deterministic, so every run counts
 * the same work, and linear in size. Each function returns a `Write` that only hands latkit the
 * arrays.
 */
import { reference, type Values } from 'latkit';
import { congruential } from '../../npm/examples/src/random.ts';
import type { Write } from './stage.ts';

/** Samples per second on the time axis. */
const RATE = 60;

/** `n` points in the unit square, each with a value, and a name when `named`. */
export function scatter(n: number, seed = 1, named = false): Write {
  const next = congruential(seed);
  const [x, y, v] = [new Float64Array(n), new Float64Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) [x[i], y[i], v[i]] = [next(), next(), next()];
  const fields: Record<string, Values> = { x, y, v };
  if (named) fields.name = Array.from({ length: n }, (_, i) => `P${i}`);
  return (p) => p.set('Point', { count: n }, fields);
}

/** About `n` buses in a square lattice over most of the globe, each joined by a line to its
 * neighbours in the next column and the next row. It has a grid's shape at any size. */
export function lattice(n: number): Write {
  const side = Math.max(2, Math.round(Math.sqrt(n)));
  const count = side * side;
  const [lon, lat, load] = [
    new Float64Array(count),
    new Float64Array(count),
    new Float32Array(count),
  ];
  for (let i = 0; i < count; i++) {
    lon[i] = -170 + (340 * (i % side)) / (side - 1);
    lat[i] = -75 + (150 * Math.floor(i / side)) / (side - 1);
    load[i] = Math.hypot(lon[i]! / 170, lat[i]! / 75) / Math.SQRT2;
  }
  const lines = 2 * side * (side - 1);
  const [from, to] = [new Uint32Array(lines), new Uint32Array(lines)];
  let e = 0;
  for (let i = 0; i < count; i++) {
    if (i % side < side - 1) {
      from[e] = i;
      to[e++] = i + 1;
    }
    if (i + side < count) {
      from[e] = i;
      to[e++] = i + side;
    }
  }
  return (p) =>
    p
      .set('Bus', { count }, { lon, lat, load })
      .set('Line', { count: lines }, { from: reference('Bus', from), to: reference('Bus', to) });
}

/** `n` edges among 16 vertices on a ring, each joining a vertex to the next, so each pair has about
 * `n / 16` parallel edges drawn as lanes. */
export function lanes(n: number): Write {
  const k = 16;
  const x = Float64Array.from({ length: k }, (_, i) => Math.cos((2 * Math.PI * i) / k));
  const y = Float64Array.from({ length: k }, (_, i) => Math.sin((2 * Math.PI * i) / k));
  const from = Uint32Array.from({ length: n }, (_, e) => e % k);
  const to = Uint32Array.from({ length: n }, (_, e) => (e + 1) % k);
  return (p) =>
    p
      .set('Point', { count: k }, { x, y, v: new Float32Array(k) })
      .set('Link', { count: n }, { from: reference('Point', from), to: reference('Point', to) });
}

/** `n` regular polygons of `sides` sides (32 by default) in a grid over the Mercator world, each
 * with a value. */
export function polygons(n: number, sides = 32): Write {
  const across = Math.ceil(Math.sqrt(2 * n));
  const [w, h] = [340 / across, 140 / Math.ceil(n / across)];
  const r = 0.4 * Math.min(w, h);
  const rings = new Array<[number, number][][]>(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [cx, cy] = [-170 + ((i % across) + 0.5) * w, -70 + (Math.floor(i / across) + 0.5) * h];
    const ring = Array.from({ length: sides + 1 }, (_, k): [number, number] => {
      const a = (2 * Math.PI * (k % sides)) / sides;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
    rings[i] = [ring];
    v[i] = (i % 97) / 97;
  }
  return (p) => p.set('Region', { count: n }, { rings, v });
}

/** `n` blocks in binary trees of 64. Each block's output is a net, and its two children's inputs
 * reference that net. */
export function blocks(n: number): Write {
  const input = new Array<number | null>(n);
  const name = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const k = i % 64;
    input[i] = k === 0 ? null : i - k + ((k - 1) >> 1);
    name[i] = `Block ${i}`;
  }
  return (p) =>
    p
      .set('Net', { count: n }, { k: new Float32Array(n) })
      .set(
        'Block',
        { count: n },
        { name, in: reference('Net', input), out: reference('Net', { count: n }) },
      );
}

const wave = (r: number, f: number) => Math.sin(r * 0.37 + f * 0.05) + (r % 10) * 0.2;

/** `rows` traces of `frames` samples at `RATE` samples per second, each a different wave. */
export function traces(rows: number, frames: number): Write {
  const all = new Float32Array(rows * frames);
  for (let f = 0; f < frames; f++) for (let r = 0; r < rows; r++) all[f * rows + r] = wave(r, f);
  const k = Float32Array.from({ length: rows }, (_, r) => r);
  return (p) => {
    p.axis('time', 's').set('Signal', { count: rows }, { k });
    for (let f = 0; f < frames; f++)
      p.append('Signal', f / RATE, { v: all.subarray(f * rows, (f + 1) * rows) });
    return p;
  };
}

/** `count` patches, each appending the next sample from frame `from` on and forgetting samples more
 * than `history` frames behind. */
export function feed(rows: number, from: number, count: number, history: number): Write[] {
  return Array.from({ length: count }, (_, i): Write => {
    const f = from + i;
    const v = Float32Array.from({ length: rows }, (_, r) => wave(r, f));
    return (p) => p.append('Signal', f / RATE, { v }).forget((f - history) / RATE);
  });
}
