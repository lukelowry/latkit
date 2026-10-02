import { expect, it } from 'vitest';
import {
  createData,
  selectBatches,
  validateBatch,
  validateSelection,
  validateSchema,
} from '../src/index.js';
import type { SampleBatch, Schema } from '../src/index.js';
const schema: Schema = {
  axis: { name: 'time' },
  types: {
    Node: {
      fields: { a: { type: 'float64', sampled: true }, b: { type: 'float64', sampled: true } },
    },
  },
};
function batch(firstFrame: number, field: string): SampleBatch {
  return {
    kind: 'samples',
    index: { source: 'test', type: 'Node', version: 'rows' },
    rows: { kind: 'range', offset: 0, count: 2 },
    firstFrame,
    coordinates: Float64Array.of(firstFrame),
    columns: {
      [field]: {
        kind: 'numeric',
        offset: 0,
        length: 2,
        values: Float64Array.of(1, 2),
        rowStride: 1,
        frameStride: 2,
      },
    },
  };
}
it('selects independent fields across gaps and out-of-order publication pages', async () => {
  const data = createData(schema, [batch(9, 'a'), batch(1, 'a'), batch(5, 'b')]);
  const result = [];
  for await (const value of selectBatches(data, [{ from: 'Node', select: ['a', 'b'] }]))
    result.push(value);
  expect(
    result.filter((b) => b.kind === 'samples').map((b) => [b.firstFrame, Object.keys(b.columns)]),
  ).toEqual([
    [1, ['a']],
    [9, ['a']],
    [5, ['b']],
  ]);
  for (const value of result) expect(validateBatch(schema, value)).toEqual([]);
});
it('keeps delivery budgets out of schema and validates demand directly', () => {
  expect(validateSchema({ ...schema, limits: { maxBlockBytes: 1 } })).not.toEqual([]);
  expect(validateSelection(schema, { from: 'Node', select: ['a'] })).toEqual([]);
  expect(validateSelection(schema, { from: 'Node', select: ['missing'] })).not.toEqual([]);
  expect(validateBatch(schema, batch(1, 'a'), { maxBlockBytes: 1 })).not.toEqual([]);
});
