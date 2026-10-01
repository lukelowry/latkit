import { describe, expect, it, vi } from 'vitest';
import type {
  Domain,
  FieldSelection,
  SampleWindow,
  SamplesBlock,
  SamplesQuery,
} from '../src/index.js';
import { blockBuffers, validateBlock, validateQuery } from '../src/index.js';
import { index, schema } from './data.js';
import { collect, FixtureModel } from './fixture.js';
import { selectFrames } from './source.js';
import { ScaleModel } from './scale/model.js';

const samples = (window: SampleWindow): SamplesQuery => ({
  kind: 'samples',
  from: 'Node',
  select: ['output'],
  rows: { kind: 'range', offset: 0, count: 1 },
  window,
});
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
/** A monitor holding one command that computed frames at these coordinates. */
async function recorded(model: FixtureModel, coordinates: readonly number[]) {
  const recording = await model.monitor(output);
  const command = model.run({ routine: 'solve', values: {} });
  for (const coordinate of coordinates) model.frame(coordinate);
  model.finish();
  await command;
  return recording;
}
const coordinates = (blocks: readonly SamplesBlock[]): number[] =>
  blocks.flatMap((block) => [...block.coordinates]);

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

describe('coherent range context', () => {
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
  it.each(cases)(
    'selects nearest frames for %j with context %j',
    async (between, context, expected) => {
      const model = new FixtureModel();
      try {
        const recording = await recorded(model, [0, 2, 2, 5, 8]);
        const window: SampleWindow = {
          kind: 'range',
          between,
          ...(context === undefined ? {} : { context }),
        };
        const query = samples(window);
        const blocks = await collect(recording.query(query, { maxBlockBytes: 1024 }));
        expect(coordinates(blocks)).toEqual(expected);
        for (const block of blocks) {
          expect(
            validateBlock(await recording.describe(), query, block, { maxBlockBytes: 1024 }),
          ).toEqual([]);
          const native = recording.stateForRead().frames![block.firstFrame].values.output;
          expect(block.columns.output.values.buffer).toBe(native.buffer);
        }
        expect(recording.copiedBytes).toBe(0);
        const aggregate = await collect(
          recording.query({
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
      } finally {
        await model.close();
      }
    },
  );
  it('reads nothing before a command, then clips context to recorded bounds', async () => {
    const model = new FixtureModel();
    try {
      const recording = await model.monitor(output);
      const wide = samples({ kind: 'range', between: [0, 10], context: { before: 10, after: 10 } });
      expect(await collect(recording.query(wide))).toEqual([]);
      const command = model.run({ routine: 'solve', values: {} });
      for (const coordinate of [0, 2, 5]) model.frame(coordinate);
      model.finish();
      await command;
      const kept = await collect(
        recording.query(
          samples({ kind: 'range', between: [2, 2], context: { before: 10, after: 10 } }),
        ),
      );
      expect(coordinates(kept)).toEqual([0, 2, 5]);
      expect(kept.map((block) => block.firstFrame)).toEqual([0, 1, 2]);
    } finally {
      await model.close();
    }
  });
  it('pins context with the header across appends', async () => {
    const model = new FixtureModel();
    try {
      const recording = await model.monitor(output);
      const command = model.run({ routine: 'solve', values: {} });
      model.frame(0);
      model.frame(2);
      const query = samples({
        kind: 'range',
        between: [1, 1],
        context: { before: 10, after: 10 },
      });
      const iterator = recording.query(query)[Symbol.asyncIterator]();
      const header = await iterator.next();
      model.frame(4);
      const blocks: SamplesBlock[] = [];
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        if (next.value.kind !== 'samples') throw new Error('Expected samples');
        expect(next.value.version).toBe(header.value?.version);
        blocks.push(next.value);
      }
      expect(coordinates(blocks)).toEqual([0, 2]);
      expect(blocks.map((block) => block.firstFrame)).toEqual([0, 1]);
      model.finish();
      await command;
    } finally {
      await model.close();
    }
  });
  it('preserves owned transfers and cancellation with context in the scale implementation', async () => {
    const model = new ScaleModel(10_003);
    try {
      const recording = await model.monitor(output);
      await model.run({ routine: 'simulate', values: { frames: 3, factor: 1 } });
      const query = samples({
        kind: 'range',
        between: [0.25, 0.75],
        context: { before: 1, after: 1 },
      });
      const blocks = await collect(
        recording.query(query, {
          buffers: 'owned',
          maxBlockBytes: 1024,
        }),
      );
      expect(coordinates(blocks)).toEqual([0, 1]);
      for (const block of blocks) {
        expect(
          validateBlock(await recording.describe(), query, block, {
            buffers: 'owned',
            maxBlockBytes: 1024,
          }),
        ).toEqual([]);
        structuredClone(block, { transfer: blockBuffers(block) as ArrayBuffer[] });
      }
      expect(coordinates(await collect(recording.query(query)))).toEqual([0, 1]);
      const controller = new AbortController();
      const iterator = recording
        .query(query, { signal: controller.signal })
        [Symbol.asyncIterator]();
      await iterator.next();
      model.pause(true);
      const pending = expect(iterator.next()).rejects.toMatchObject({ code: 'aborted' });
      await vi.waitFor(() => expect(model.stats.waitingReads).toBe(1));
      controller.abort();
      await pending;
      expect(model.stats.activeReads).toBe(0);
    } finally {
      model.pause(false);
      await model.close();
    }
  });
});

it('finds context in a million-frame index with logarithmic coordinate probes', () => {
  let probes = 0;
  class IndexedFrame {
    constructor(readonly position: number) {}
    get coordinate(): number {
      probes++;
      return this.position * 2;
    }
  }
  const frames = Array.from({ length: 1_000_000 }, (_, i) => new IndexedFrame(i));
  const selected = selectFrames(
    {
      frames,
      firstFrame: 17,
      frameCount: 1_000_017,
      firstCoordinate: 0,
    },
    {
      kind: 'range',
      between: [1_500_001, 1_500_001],
      context: { before: 1, after: 1 },
    },
  );
  expect(probes).toBeLessThanOrEqual(40);
  expect(selected.offset).toBe(750_017);
  expect(selected.frames).toHaveLength(2);
  expect(selected.frames[0]).toBe(frames[750_000]);
  expect(selected.frames[1]).toBe(frames[750_001]);
});
