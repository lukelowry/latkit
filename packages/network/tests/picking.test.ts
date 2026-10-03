import { expect, it } from 'vitest';
import { kit } from '@latkit/gpu';
import type { FieldsBlock, RowAxis } from '@latkit/model';
import type { NetworkData } from '../src/data.js';
import type { VertexBank } from '../src/geometry/topology.js';
import type { Style } from '../src/options.js';
import type { FieldRead } from '../src/rendering/fields.js';
import { HitIndex, Picking, type BoxRead, type PickGeometry } from '../src/picking.js';

it.each<RowAxis>([
  { kind: 'range', offset: 1, count: 2 },
  { kind: 'indices', values: Uint32Array.of(2, 1) },
])('fits only displayed rows when native tiles span a larger range: $kind', (rows) => {
  const index = { source: 'fixture', type: 'node', version: '1' };
  const bank: VertexBank = { id: 0, type: 'node', index, rows, count: 2, base: 0 };
  const native: FieldsBlock = {
    kind: 'fields',
    index,
    rows: { kind: 'range', offset: 0, count: 4 },
    presence: {},
    rowOffset: 0,
    columns: {
      position: {
        kind: 'vector',
        offset: 0,
        length: 4,
        size: 2,
        values: {
          kind: 'numeric',
          offset: 0,
          length: 8,
          values: Float64Array.of(999, 999, 1, 2, 3, 4, -999, -999),
        },
      },
    },
  };
  const read: FieldRead = { pages: [], native: [native], vector: true, scales: {} };
  const result = new Picking().prepare(
    { vertices: [bank], edges: [] },
    { vertices: new Map([[bank, read]]), edges: new Map() },
    0,
  );
  expect(result.bounds).toEqual([1, 2, 3, 4]);
  expect(result.position(bank, 0)).toEqual(rows.kind === 'range' ? [1, 2] : [3, 4]);
  expect(result.bytes).toBe(0);
});

/** Drive a build to its index, counting its pauses. */
function build(count: number, extent: readonly [number, number, number, number], read: BoxRead) {
  const steps = HitIndex.build(count, extent, read);
  let pauses = 0;
  for (let step = steps.next(); ; step = steps.next(), pauses++)
    if (step.done) return { index: step.value, pauses };
}
it.each([0, 1e9])('finds every box a query meets, never a non-finite one, about %d', (offset) => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const count = 5000,
    boxes = Array.from({ length: count }, (_, i) => {
      if (i % 97 === 0) return [NaN, 0, 1, 1];
      const x = offset + random() * 1000,
        y = offset + random() * 1000,
        size = i % 3 ? random() * 20 : 0;
      return [x, y, x + size, y + size * random()];
    });
  const { index, pauses } = build(count, [offset, offset, offset + 1020, offset + 1020], (i, box) =>
    box.set(boxes[i]),
  );
  expect(pauses).toBeGreaterThan(1);
  expect(index.bytes).toBe(HitIndex.bytes(count));
  for (let q = 0; q < 200; q++) {
    const x = offset + random() * 1100 - 50,
      y = offset + random() * 1100 - 50,
      r = q % 4 ? random() * 5 : random() * 200;
    const bounds = [x - r, y - r, x + r, y + r] as const,
      found = [...index.query(bounds, () => {})];
    const meets = (box: number[], slack: number) =>
      box.every(Number.isFinite) &&
      box[0] <= bounds[2] + slack &&
      box[1] <= bounds[3] + slack &&
      box[2] >= bounds[0] - slack &&
      box[3] >= bounds[1] - slack;
    expect(new Set(found).size).toBe(found.length);
    // Float32 boxes about the data's center round outward by at most a few ulps of the extent.
    for (const item of found) expect(meets(boxes[item], 1e-3)).toBe(true);
    const exact = boxes.flatMap((box, i) => (meets(box, 0) ? [i] : []));
    expect(found).toEqual(expect.arrayContaining(exact));
  }
});
it('keeps about 21 bytes per item and queries an empty index', () => {
  expect(HitIndex.bytes(1_000_000) / 1_000_000).toBeCloseTo(21.07, 2);
  const { index } = build(0, [0, 0, 0, 0], () => {});
  expect([...index.query([-1, -1, 1, 1], () => {})]).toEqual([]);
  const single = build(1, [2, 3, 2, 3], (_, box) => box.set([2, 3, 2, 3])).index;
  expect([...single.query([2, 3, 2, 3], () => {})]).toEqual([0]);
  expect([...single.query([2.001, 3, 3, 4], () => {})]).toEqual([]);
});
it('builds an index in cooperative slices and frees one aborted part way', async () => {
  const count = 20000,
    index = { source: 'fixture', type: 'node', version: '1' },
    rows = { kind: 'range', offset: 0, count } as const;
  const bank: VertexBank = { id: 0, type: 'node', index, rows, count, base: 0 };
  const values = Float64Array.from({ length: count * 2 }, (_, i) => i);
  const native: FieldsBlock = {
    kind: 'fields',
    index,
    rows,
    presence: {},
    rowOffset: 0,
    columns: {
      position: {
        kind: 'vector',
        offset: 0,
        length: count,
        size: 2,
        values: { kind: 'numeric', offset: 0, length: values.length, values },
      },
    },
  };
  const read: FieldRead = { pages: [], native: [native], vector: true, scales: {} };
  const data = {} as NetworkData,
    style = { markers: true, lines: false } as Style;
  // Each build pauses after every step.
  const start = () => {
    const picking = new Picking().prepare(
        { vertices: [bank], edges: [] },
        { vertices: new Map([[bank, read]]), edges: new Map() },
        64 * 1024 ** 2,
      ),
      stop = new AbortController();
    const later = picking.indexLater(data, style, new kit.Work(stop.signal, Infinity, 0));
    return { picking, stop, later };
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Which stage the bank's index is in. */
  const stage = (picking: PickGeometry) => {
    const { spatial } = (
      picking as unknown as {
        vertices: Map<VertexBank, { spatial: { index?: HitIndex; building?: object } }>;
      }
    ).vertices.get(bank)!;
    return spatial.index ? 'built' : spatial.building ? 'building' : 'missing';
  };
  const finished = start();
  await pause();
  expect(stage(finished.picking)).toBe('building');
  expect(finished.picking.bytes).toBe(HitIndex.bytes(count));
  expect(finished.picking.indexable(data, style)).toBe(false);
  await finished.later;
  expect(stage(finished.picking)).toBe('built');
  expect(finished.picking.bytes).toBe(HitIndex.bytes(count));
  const aborted = start();
  await pause();
  expect(aborted.picking.bytes).toBe(HitIndex.bytes(count));
  aborted.stop.abort();
  expect(stage(aborted.picking)).toBe('missing');
  expect(aborted.picking.bytes).toBe(0);
  await expect(aborted.later).rejects.toThrow();
  expect(aborted.picking.indexable(data, style)).toBe(true);
});
