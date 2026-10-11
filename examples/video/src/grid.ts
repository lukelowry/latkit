/**
 * A small grid for the exported network: buses on a jittered lattice over the continental US, each
 * joined to its right and lower neighbours, and a few long lines bent through a point between.
 */
import { createData, type Column, type Data, type Index } from '@latkit/model';

const COLS = 16,
  ROWS = 10,
  WEST = -122,
  EAST = -70,
  SOUTH = 27,
  NORTH = 47;

/** A repeatable sequence in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const numeric = (values: Float32Array): Column => ({
  kind: 'numeric',
  offset: 0,
  length: values.length,
  values,
});
const vector = (values: Float32Array): Column => ({
  kind: 'vector',
  offset: 0,
  length: values.length / 2,
  size: 2,
  values: { kind: 'numeric', offset: 0, length: values.length, values },
});

export function grid(): Data {
  const next = random(0x51a7c0de),
    count = COLS * ROWS,
    position = new Float32Array(count * 2),
    load = new Float32Array(count),
    from: number[] = [],
    to: number[] = [],
    bends: number[][] = [];
  const line = (a: number, b: number, through: number[] = []) => {
    from.push(a);
    to.push(b);
    bends.push(through);
  };
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c,
        x = WEST + ((c + 0.5 + (next() - 0.5) * 0.8) * (EAST - WEST)) / COLS,
        y = SOUTH + ((r + 0.5 + (next() - 0.5) * 0.8) * (NORTH - SOUTH)) / ROWS;
      position.set([x, y], i * 2);
      load[i] = 0.5 + 0.5 * Math.sin(c * 0.7) * Math.cos(r * 0.9);
      for (const j of [c + 1 < COLS ? i + 1 : -1, r + 1 < ROWS ? i + COLS : -1])
        if (j >= 0) line(i, j);
    }
  // Long lines across the grid, each bent through a point off its straight course.
  for (let k = 0; k < 6; k++) {
    const a = Math.floor(next() * count),
      b = Math.floor(next() * count);
    if (a === b) continue;
    const middle = (axis: number) => (position[a * 2 + axis]! + position[b * 2 + axis]!) / 2;
    line(a, b, [middle(0), middle(1) + (next() - 0.5) * 8]);
  }
  const offsets = new Int32Array(bends.length + 1);
  bends.forEach((points, e) => (offsets[e + 1] = offsets[e]! + points.length / 2));
  const index = (type: string): Index => ({ source: 'video-grid', type, version: '1' }),
    reference = (rows: number[]): Column => ({
      kind: 'reference',
      index: index('Bus'),
      offset: 0,
      length: rows.length,
      values: Uint32Array.from(rows),
    });
  return createData(
    {
      types: {
        Bus: {
          fields: {
            position: { type: { kind: 'vector', size: 2, items: 'float32' }, geographic: true },
            load: { type: 'float32' },
          },
        },
        Line: {
          fields: {
            from: { type: { kind: 'reference', to: 'Bus' } },
            to: { type: { kind: 'reference', to: 'Bus' } },
            bends: {
              type: { kind: 'list', items: { kind: 'vector', size: 2, items: 'float32' } },
              geographic: true,
            },
          },
        },
      },
    },
    [
      {
        kind: 'rows',
        index: index('Bus'),
        rows: { kind: 'range', offset: 0, count },
        columns: { position: vector(position), load: numeric(load) },
      },
      {
        kind: 'rows',
        index: index('Line'),
        rows: { kind: 'range', offset: 0, count: from.length },
        columns: {
          from: reference(from),
          to: reference(to),
          bends: {
            kind: 'list',
            offset: 0,
            length: bends.length,
            offsets,
            values: vector(Float32Array.from(bends.flat())),
          },
        },
      },
    ],
  );
}
