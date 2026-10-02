import { expect, it } from 'vitest';
import {
  validateBlock,
  validateQuery,
  validateSchema,
  blockBuffers,
  blockByteLength,
  type Schema,
  type EnvelopeQuery,
  type EnvelopeBlock,
} from '../src/index.js';
const schema: Schema = {
  axis: { name: 'coordinate' },

  types: { node: { fields: { value: { type: 'float64', sampled: true, nullable: true } } } },
};
const query: EnvelopeQuery = {
  kind: 'envelope',
  from: 'node',
  select: ['value'],
  window: { kind: 'range', between: [0, 4] },
  buckets: 2,
};
function block(): EnvelopeBlock {
  return {
    kind: 'envelope',
    index: { source: 'd', type: 'node', version: 'i' },
    rows: { kind: 'range', offset: 0, count: 1 },
    rowOffset: 0,
    firstBucket: 0,
    bucketCount: 2,
    columns: {
      value: {
        values: {
          kind: 'numeric',
          offset: 0,
          length: 8,
          values: Float64Array.of(2, 1, 4, 4, 0, 0, 0, 0),
          validity: Uint8Array.of(15),
        },
        coordinates: Float64Array.of(0, 1, 1, 1, 0, 0, 0, 0),
        frames: Float64Array.of(2 ** 40, 2 ** 40 + 1, 2 ** 40 + 2, 2 ** 40 + 2, 0, 0, 0, 0),
        continuous: Uint8Array.of(1),
      },
    },
  };
}
it('validates optional native summaries and accounts every exposed backing', () => {
  expect(validateSchema(schema)).toEqual([]);
  expect(validateQuery(schema, query)).toEqual([]);
  expect(validateBlock(schema, query, block())).toEqual([]);
  expect(blockBuffers(block())).toHaveLength(5);
  expect(blockByteLength(block())).toBeGreaterThan(3 * 8 * 8);
  expect(validateSchema({ ...schema, axis: undefined })).not.toEqual([]);
  expect(validateQuery(schema, query)).toEqual([]);
});
it('rejects invented times, partial slots, nonfinite summaries, invalid extrema and truncated bitmaps', () => {
  for (const change of [
    (b: EnvelopeBlock) => {
      b.columns.value.coordinates[1] = 3;
    },
    (b: EnvelopeBlock) => {
      b.columns.value.frames[1] = 0.5;
    },
    (b: EnvelopeBlock) => {
      b.columns.value.values.validity![0] = 7;
    },
    (b: EnvelopeBlock) => {
      b.columns.value.values.values[2] = Infinity;
    },
    (b: EnvelopeBlock) => {
      b.columns.value.values.values[1] = 99;
    },
    (b: EnvelopeBlock) => {
      b.columns.value.continuous[0] = 3;
    },
  ]) {
    const b = block();
    change(b);
    expect(validateBlock(schema, query, b)).not.toEqual([]);
  }
  expect(validateBlock(schema, query, { ...block(), bucketCount: 3 })).not.toEqual([]);
});
it('requires coordinate buckets and a single bucket for a zero-width interval', () => {
  expect(
    validateQuery(schema, { ...query, window: { kind: 'frames', offset: 0, count: 5 } }),
  ).not.toEqual([]);
  expect(
    validateQuery(schema, { ...query, window: { kind: 'range', between: [2, 2] } }),
  ).not.toEqual([]);
  expect(validateQuery(schema, { ...query, buckets: 0 })).not.toEqual([]);
});
