import { describe, expect, it } from 'vitest';
import {
  read,
  validateBlock,
  validateQuery,
  type Domain,
  type SampleWindow,
  type SamplesQuery,
  type SamplesBlock,
} from '../src/index.js';
import { schema, index } from './data.js';
import { sampledData, collect } from './fixture.js';
const samples = (window: SampleWindow): SamplesQuery => ({
  kind: 'samples',
  from: 'Node',
  select: ['output'],
  rows: { kind: 'range', offset: 0, count: 1 },
  window,
});
describe('range context validation', () => {
  it.each([{}, { before: 0 }, { after: 1 }, { before: Number.MAX_SAFE_INTEGER, after: 2 }])(
    'accepts nonnegative frame counts: %j',
    (context) => {
      expect(validateQuery(schema, samples({ kind: 'range', between: [2, 2], context }))).toEqual(
        [],
      );
    },
  );
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'rejects invalid counts on either side: %j',
    (value) => {
      for (const side of ['before', 'after']) {
        const query = {
          ...samples({ kind: 'range', between: [2, 2] }),
          window: { kind: 'range', between: [2, 2], context: { [side]: value } },
        };
        expect(validateQuery(schema, query)).not.toEqual([]);
      }
    },
  );
  it.each([null, [], 1, 'context', undefined])('rejects a malformed context: %j', (context) => {
    expect(
      validateQuery(schema, {
        ...samples({ kind: 'range', between: [2, 2] }),
        window: { kind: 'range', between: [2, 2], context },
      }),
    ).not.toEqual([]);
  });
  it.each([
    { kind: 'at', value: 2 },
    { kind: 'frames', offset: 0, count: 1 },
  ])('rejects context on other window kinds: %j', (window) => {
    expect(
      validateQuery(schema, {
        ...samples({ kind: 'at', value: 2 }),
        window: { ...window, context: { before: 1 } },
      }),
    ).not.toEqual([]);
  });
  it('bounds context per tile while retaining ordinary range validation', () => {
    const block = (values: number[]): SamplesBlock => ({
      kind: 'samples',
      version: '1',
      index,
      rows: { kind: 'range', offset: 0, count: 1 },
      rowOffset: 0,
      firstFrame: 0,
      coordinates: Float64Array.from(values),
      columns: {
        output: {
          kind: 'numeric',
          values: Float64Array.from(values),
          offset: 0,
          length: values.length,
          frameStride: 1,
          rowStride: 1,
        },
      },
    });
    const query = samples({
      kind: 'range',
      between: [2, 2],
      context: { before: 2, after: 1 },
    });
    expect(validateBlock(schema, query, block([0, 1, 2, 2, 4]))).toEqual([]);
    expect(validateBlock(schema, query, block([0, 1]))).toEqual([]);
    expect(validateBlock(schema, query, block([4]))).toEqual([]);
    expect(validateBlock(schema, query, block([-1, 0, 1, 2]))).not.toEqual([]);
    expect(validateBlock(schema, query, block([2, 4, 5]))).not.toEqual([]);
    expect(
      validateBlock(schema, samples({ kind: 'range', between: [2, 2] }), block([1, 2])),
    ).not.toEqual([]);
  });
});

describe('local coordinate selection', () => {
  const cases: readonly [
    Domain,
    { before?: number; after?: number } | undefined,
    readonly number[],
  ][] = [
    [[2, 2], undefined, [2, 2]],
    [[2, 2], {}, [2, 2]],
    [[2, 2], { before: 1, after: 1 }, [0, 2, 2, 5]],
    [[3, 4], { before: 1, after: 1 }, [2, 5]],
    [[3, 4], { before: 2 }, [2, 2]],
    [[-3, -1], { before: 1, after: 1 }, [0]],
    [[9, 10], { before: 1, after: 1 }, [8]],
    [[0, 8], { before: 10, after: 10 }, [0, 2, 2, 5, 8]],
    [[3, 4], { before: Number.MAX_SAFE_INTEGER, after: Number.MAX_SAFE_INTEGER }, [0, 2, 2, 5, 8]],
  ];
  it.each(cases)('selects context for %j / %j', async (between, context, expected) => {
    const data = sampledData([0, 2, 2, 5, 8]),
      window: SampleWindow = {
        kind: 'range',
        between,
        ...(context === undefined ? {} : { context }),
      },
      query = samples(window);
    const blocks = await collect(read(data, query, { maxBlockBytes: 1024 }));
    expect(blocks.flatMap((b) => [...b.coordinates])).toEqual(expected);
    for (const block of blocks)
      expect(validateBlock(data.schema, query, block, { maxBlockBytes: 1024 })).toEqual([]);
    const aggregate = await collect(
      read(data, {
        kind: 'aggregate',
        from: 'Node',
        select: ['output'],
        rows: query.rows,
        measures: ['min', 'max'],
        window,
      }),
    );
    expect(aggregate[0].values.output).toEqual({
      count: expected.length,
      min: expected.length ? Math.min(...expected) + 1 : null,
      max: expected.length ? Math.max(...expected) + 1 : null,
    });
  });
});
