import { expect, it } from 'vitest';
import { Work, type FieldsBlock, type RowAxis } from '@latkit/model';
import type { NetworkData } from '../src/data.js';
import type { VertexBank } from '../src/geometry/topology.js';
import type { Style } from '../src/options.js';
import { FieldRead, VERTEX, channels } from '../src/rendering/fields.js';
import { kit } from '@latkit/gpu';
import { Picking, type PickGeometry } from '../src/picking.js';
import { Adjacency } from '../src/geometry/adjacency.js';

/** No edges: nothing to draw apart. */
const adjacency = new Adjacency([], [], [], 0, 0);

/** A two-lane position field, read as the column of its x. */
const position = channels({ x: 'p', y: { field: 'p', component: 1 } }, VERTEX);
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
      x: {
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
  const read = new FieldRead([], [native], position);
  const result = new Picking().prepare(
    { vertices: [bank], edges: [], adjacency },
    { vertices: new Map([[bank, read]]), edges: new Map() },
    0,
  );
  expect(result.bounds).toEqual([1, 2, 3, 4]);
  expect(result.position(bank, 0)).toEqual(rows.kind === 'range' ? [1, 2] : [3, 4]);
  expect(result.bytes).toBe(0);
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
      x: {
        kind: 'vector',
        offset: 0,
        length: count,
        size: 2,
        values: { kind: 'numeric', offset: 0, length: values.length, values },
      },
    },
  };
  const read = new FieldRead([], [native], position);
  const data = {} as NetworkData,
    style = { markers: true, lines: false } as Style;
  // Each build pauses after every step.
  const start = () => {
    const picking = new Picking().prepare(
        { vertices: [bank], edges: [], adjacency },
        { vertices: new Map([[bank, read]]), edges: new Map() },
        64 * 1024 ** 2,
      ),
      stop = new AbortController();
    const later = picking.indexLater(data, style, new Work(stop.signal, Infinity, 0));
    return { picking, stop, later };
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Which stage the bank's index is in. */
  const stage = (picking: PickGeometry) => {
    const { spatial } = (
      picking as unknown as {
        vertices: Map<VertexBank, { spatial: { index?: kit.BoxIndex; building?: object } }>;
      }
    ).vertices.get(bank)!;
    return spatial.index ? 'built' : spatial.building ? 'building' : 'missing';
  };
  const finished = start();
  await pause();
  expect(stage(finished.picking)).toBe('building');
  expect(finished.picking.bytes).toBe(kit.BoxIndex.bytes(count));
  expect(finished.picking.indexable(data, style)).toBe(false);
  await finished.later;
  expect(stage(finished.picking)).toBe('built');
  expect(finished.picking.bytes).toBe(kit.BoxIndex.bytes(count));
  const aborted = start();
  await pause();
  expect(aborted.picking.bytes).toBe(kit.BoxIndex.bytes(count));
  aborted.stop.abort();
  expect(stage(aborted.picking)).toBe('missing');
  expect(aborted.picking.bytes).toBe(0);
  await expect(aborted.later).rejects.toThrow();
  expect(aborted.picking.indexable(data, style)).toBe(true);
});
