/**
 * What the scenarios draw, made before anything is measured: deterministic, so every run counts the
 * same work, and linear in size. Each returns a `Write` that only hands latkit the arrays.
 */
import { reference, type Values } from 'latkit';
import type { Write } from './stage.ts';

/** Axis coordinates a second. */
const RATE = 60;

/** Numbers in [0, 1), the same every run. */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** `n` points in the unit square, each with a value, and a name when `named`. */
export function scatter(n: number, seed = 1, named = false): Write {
  const next = random(seed);
  const [x, y, v] = [new Float64Array(n), new Float64Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) [x[i], y[i], v[i]] = [next(), next(), next()];
  const fields: Record<string, Values> = { x, y, v };
  if (named) fields.name = Array.from({ length: n }, (_, i) => `P${i}`);
  return (p) => p.set('Point', { count: n }, fields);
}

/** About `n` buses in a square lattice over most of the globe, each joined to its right and lower
 * neighbours: a grid's shape at any size. */
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

/** `n` edges among 16 vertices on a ring, each joining a vertex to the next: lanes by the thousand. */
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

/** `n` regular 32-gons in a grid over the mercator world, each with a value. */
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

/** `n` blocks in trees of 64: each block's output is a net, which its two children's inputs name. */
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

/** `rows` traces of `frames` samples at 60 a second, each its own wave. */
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

/** `count` patches recording the frames from `from` on, each forgetting what falls `history` behind. */
export function feed(rows: number, from: number, count: number, history: number): Write[] {
  return Array.from({ length: count }, (_, i): Write => {
    const f = from + i;
    const v = Float32Array.from({ length: rows }, (_, r) => wave(r, f));
    return (p) => p.append('Signal', f / RATE, { v }).forget((f - history) / RATE);
  });
}
