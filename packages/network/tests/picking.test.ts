import { expect, it } from 'vitest';
import type { NativeFields } from '@latkit/gpu';
import type { RowAxis } from '@latkit/model';
import type { VertexBank } from '../src/geometry/connectivity.js';
import type { FieldRead } from '../src/rendering/fields.js';
import { Picking } from '../src/picking.js';

it.each<RowAxis>([
  { kind: 'range', offset: 1, count: 2 },
  { kind: 'indices', values: Uint32Array.of(2, 1) },
])('fits only displayed rows when native tiles span a larger range: $kind', (rows) => {
  const index = { document: 'fixture', type: 'node', version: '1' };
  const bank: VertexBank = { id: 0, type: 'node', index, rows, count: 2, base: 0 };
  const native: NativeFields = {
    versions: new Map(),
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
    retain: () => () => {},
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
