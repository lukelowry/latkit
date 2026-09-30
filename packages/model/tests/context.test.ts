import { describe, expect, it, vi } from 'vitest';
import type { Domain, SampleWindow, SamplesBlock, SamplesQuery } from '../src/index.js';
import { blockBuffers, validateBlock, validateQuery } from '../src/index.js';
import { index, schema } from './data.js';
import { collect, FixtureModel } from './fixture.js';
import { selectFrames } from './source.js';
import { ScaleService } from './scale/service.js';

const samples = (window: SampleWindow): SamplesQuery => ({
  kind: 'samples',
  from: 'Node',
  select: ['output'],
  rows: { kind: 'range', offset: 0, count: 1 },
  window,
});
const config = {
  scope: { kind: 'live' },
  fields: [{ from: 'Node', select: ['output'] }],
  retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
} as const;
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
      schemaVersion: schema.version,
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
        const recording = await model.monitor(config);
        for (const coordinate of [0, 2, 2, 5, 8]) model.live(coordinate);
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
  it('clips context to retained bounds but does not hide expired base intervals', async () => {
    const model = new FixtureModel();
    try {
      const recording = await model.monitor({
        ...config,
        retain: { kind: 'rolling', frames: 2, bytes: 80, onLimit: 'fail' },
      });
      const empty = await collect(
        recording.query(
          samples({
            kind: 'range',
            between: [0, 10],
            context: { before: 10, after: 10 },
          }),
        ),
      );
      expect(empty).toEqual([]);
      for (const coordinate of [0, 2, 5]) model.live(coordinate);
      const kept = await collect(
        recording.query(
          samples({
            kind: 'range',
            between: [2, 2],
            context: { before: 10, after: 10 },
          }),
        ),
      );
      expect(coordinates(kept)).toEqual([2, 5]);
      expect(kept.map((block) => block.firstFrame)).toEqual([1, 2]);
      await expect(
        collect(
          recording.query(
            samples({
              kind: 'range',
              between: [0, 2],
              context: { before: 1, after: 1 },
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'expired' });
    } finally {
      await model.close();
    }
  });
  it('pins context with the header across append and eviction', async () => {
    const model = new FixtureModel();
    try {
      const recording = await model.monitor({
        ...config,
        retain: { kind: 'rolling', frames: 2, bytes: 80, onLimit: 'fail' },
      });
      model.live(0);
      model.live(2);
      const query = samples({
        kind: 'range',
        between: [1, 1],
        context: { before: 10, after: 10 },
      });
      const iterator = recording.query(query)[Symbol.asyncIterator]();
      const header = await iterator.next();
      model.live(4);
      const blocks: SamplesBlock[] = [];
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        if (next.value.kind !== 'samples') throw new Error('Expected samples');
        expect(next.value.version).toBe(header.value?.version);
        blocks.push(next.value);
      }
      expect(coordinates(blocks)).toEqual([0, 2]);
      expect(blocks.map((block) => block.firstFrame)).toEqual([0, 1]);
    } finally {
      await model.close();
    }
  });
  it('preserves owned transfers and cancellation with context in the scale implementation', async () => {
    const service = new ScaleService(10_003);
    const document = await service.open();
    const model = await service.model(document.id);
    try {
      const recording = await model.monitor!({
        ...config,
        retain: { kind: 'all', bytes: 1_000_000, onLimit: 'fail' },
      });
      await model.call!({ routine: 'advance', values: { frames: 3, factor: 1 } });
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
      service.pause(true);
      const pending = expect(iterator.next()).rejects.toMatchObject({ code: 'aborted' });
      await vi.waitFor(() => expect(service.stats.waitingReads).toBe(1));
      controller.abort();
      await pending;
      expect(service.stats.activeReads).toBe(0);
    } finally {
      service.pause(false);
      await model.close();
      await document.close();
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
