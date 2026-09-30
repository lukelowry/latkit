import { describe, expect, it } from 'vitest';
import type { MonitorConfig, QueryHeader, RowsBlock, SamplesQuery, Update } from '../src/index.js';
import { blockBuffers, blockByteLength, validateBlock, validateSchema } from '../src/index.js';
import { FixtureModel, collect } from './fixture.js';
import { axisValues } from './source.js';
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const monitor = (scope: MonitorConfig['scope'] = { kind: 'live' }): MonitorConfig => ({
  scope,
  fields: [{ from: 'Node', select: ['output'] }],
  retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
});
const samples = (window: SamplesQuery['window']): SamplesQuery => ({
  kind: 'samples',
  from: 'Node',
  select: ['output'],
  window,
});
const cells = (blocks: RowsBlock[]): number[] =>
  blocks.flatMap((block) => {
    const column = block.columns.value;
    if (column.kind !== 'numeric') throw new Error('Expected numeric');
    return [...column.values.subarray(column.offset, column.offset + column.length)];
  });

describe('coherent streams and query semantics', () => {
  it('pins schema with data on first pull, including empty reads', async () => {
    const model = new FixtureModel();
    const stream = model.document.query(rows)[Symbol.asyncIterator]();
    const header = (await stream.next()).value as QueryHeader;
    expect(header.kind).toBe('schema');
    expect(validateSchema(header.schema)).toEqual([]);
    const original = model.document.state;
    await model.document.replace();
    const remaining: RowsBlock[] = [];
    for (let result = await stream.next(); !result.done; result = await stream.next())
      if (result.value.kind === 'rows') remaining.push(result.value);
    expect(cells(remaining)).toEqual([1, 2, 3, 4]);
    for (const block of remaining) {
      expect(block.version).toBe(header.version);
      expect(block.index).toBe(original.index);
    }
    const empty = [];
    for await (const block of model.document.query({
      ...rows,
      rows: { kind: 'range', offset: 0, count: 0 },
    }))
      empty.push(block);
    expect(empty).toHaveLength(1);
    expect(empty[0].kind).toBe('schema');
    const counted = await collect(
      model.document.query({
        ...rows,
        where: [{ field: 'value', operator: 'greaterThan', value: 100 }],
        count: true,
      }),
    );
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ rows: { kind: 'range', count: 0 }, total: 0 });
  });
  it('filters, sorts, paginates, counts, and preserves physical tie order', async () => {
    const model = new FixtureModel();
    await model.document.edit([{ kind: 'set', id: 'n2', values: { value: 3 } }]);
    const query = {
      ...rows,
      where: [{ field: 'value', operator: 'greaterThanOrEqual', value: 2 }] as const,
      orderBy: [{ field: 'value', direction: 'descending' }] as const,
      offset: 1,
      limit: 2,
      count: true,
    };
    const blocks = await collect(model.document.query(query));
    expect(blocks.flatMap((block) => axisValues(block.rows))).toEqual([1, 2]);
    expect(cells(blocks)).toEqual([3, 3]);
    expect(blocks[0].total).toBe(3);
    for (const [operator, value, expected] of [
      ['equal', 3, [3, 3]],
      ['notEqual', 3, [1, 4]],
      ['lessThan', 3, [1]],
      ['lessThanOrEqual', 3, [1, 3, 3]],
      ['greaterThan', 3, [4]],
    ] as const) {
      expect(
        cells(
          await collect(
            model.document.query({ ...rows, where: [{ field: 'value', operator, value }] }),
          ),
        ),
      ).toEqual(expected);
    }
    const aggregate = await collect(
      model.document.query({
        kind: 'aggregate',
        from: 'Node',
        select: ['value'],
        measures: ['min', 'max'],
        rows: { kind: 'ids', ids: ['n1', 'n2'] },
      }),
    );
    expect(aggregate[0].values.value).toEqual({ count: 2, min: 1, max: 3 });
  });
  it('uses ranges without identity allocation and compacts owned allocations to the byte bound', async () => {
    const model = new FixtureModel();
    model.document.state = {
      ...model.document.state,
      values: new Float64Array(new ArrayBuffer(1024 * 1024), 0, 4),
    };
    const borrowed = await collect(model.document.query(rows));
    expect(borrowed[0].rows).toEqual({ kind: 'range', offset: 0, count: 2 });
    expect(model.document.copiedBytes).toBe(0);
    const bound = blockByteLength(borrowed[0]);
    expect(
      validateBlock(await model.document.describe(), rows, borrowed[0], {
        buffers: 'owned',
        maxBlockBytes: bound,
      }),
    ).toMatchObject([{ code: 'resource-limit' }]);
    const owned = await collect(
      model.document.query(rows, { buffers: 'owned', maxBlockBytes: bound }),
    );
    expect(model.document.copiedBytes).toBe(32);
    for (const block of owned) {
      expect(blockBuffers(block).reduce((total, buffer) => total + buffer.byteLength, 0)).toBe(16);
      expect(
        validateBlock(await model.document.describe(), rows, block, {
          buffers: 'owned',
          maxBlockBytes: bound,
        }),
      ).toEqual([]);
    }
  });
  it('preserves reset inputs and rejects stale identities after replacement', async () => {
    const model = new FixtureModel();
    const original = model.document.state;
    await model.document.replace();
    const opened = model.document.state;
    await model.reset();
    expect(model.document.state).toBe(opened);
    const ids = [...original.ids, ...opened.ids];
    expect(new Set(ids).size).toBe(ids.length);
    await expect(
      model.document.edit([{ kind: 'set', id: original.ids[0], values: { value: 2 } }]),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      collect(
        model.document.query({
          ...rows,
          rows: { kind: 'range', offset: 0, count: 1, index: original.index },
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['abort', 'close'] as const)(
    'interrupts a pending backend pull on %s',
    async (action) => {
      const model = new FixtureModel();
      const controller = new AbortController();
      model.document.readGate = new Promise(() => {});
      const iterator = model.document
        .query(rows, { signal: controller.signal })
        [Symbol.asyncIterator]();
      await iterator.next();
      const pending = iterator.next();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
      if (action === 'abort') controller.abort();
      else await model[action]();
      await rejected;
      expect(model.document.released).toBe(1);
      expect(model.document.pulls).toBe(0);
    },
  );
});

describe('recording binding and observation coverage', () => {
  it('publishes ready metadata before the accepted command notification', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(monitor({ kind: 'command', id: 'a' }));
    expect(recording.axis).toBeNull();
    expect(recording.fields).toBeNull();
    let settled = false;
    void recording.ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    model.on('command', () => {
      expect(recording.axis).toEqual({ name: 'time', unit: 's' });
      expect(recording.fields?.[0].rows).toEqual({ kind: 'range', offset: 0, count: 4 });
    });
    const done = model.call({ routine: 'solve', values: {} }, { id: 'a' });
    await recording.ready;
    expect((await recording.describe()).axis).toBe(recording.axis);
    expect((await model.document.describe()).axis).toBeUndefined();
    model.complete('a');
    await done;
  });
  it('fails invalid binding without cancelling a valid command', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor({
      ...monitor({ kind: 'command', id: 'a' }),
      fields: [{ from: 'Node', select: ['missing'] }],
    });
    const rejected = expect(recording.ready).rejects.toMatchObject({ code: 'invalid-input' });
    const done = model.call({ routine: 'solve', values: {} }, { id: 'a' });
    await rejected;
    expect(model.work.has('a')).toBe(true);
    expect(await recording.done).toMatchObject({ status: 'failed' });
    model.complete('a');
    await done;
  });
  it.each(['stop', 'close', 'reset'] as const)(
    'rejects readiness when %s precedes binding',
    async (action) => {
      const model = new FixtureModel();
      const recording = await model.monitor(monitor({ kind: 'command', id: 'unused' }));
      const rejected = expect(recording.ready).rejects.toMatchObject({ code: 'aborted' });
      if (action === 'reset') await model.reset();
      else await recording[action]();
      await rejected;
      expect(recording.documentVersion).toBeNull();
    },
  );
  it('resolves each field selection once and uses their physical-order intersection', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor({
      ...monitor(),
      fields: [
        { from: 'Node', select: ['output'], rows: { kind: 'ids', ids: ['n4', 'n2', 'n3'] } },
        { from: 'Node', select: ['other'], rows: { kind: 'range', offset: 2, count: 2 } },
      ],
    });
    await recording.ready;
    model.live(0);
    expect(recording.fields?.map((field) => axisValues(field.rows))).toEqual([
      [3, 1, 2],
      [2, 3],
    ]);
    const query = {
      ...samples({ kind: 'frames', offset: 0, count: 1 }),
      select: ['output', 'other'],
    };
    const blocks = await collect(recording.query(query));
    expect(blocks.flatMap((block) => axisValues(block.rows))).toEqual([2, 3]);
    expect([...blocks[0].columns.output.values]).toEqual([3, 4]);
    expect([...blocks[0].columns.other.values]).toEqual([30, 40]);
    await expect(
      collect(recording.query({ ...query, rows: { kind: 'range', offset: 1, count: 2 } })),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });
  it('selects duplicate coordinates, empty prehistory, sampled rows, and aggregate windows', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(monitor());
    model.live(2);
    model.live(2);
    model.live(5);
    const at = await collect(recording.query(samples({ kind: 'at', value: 2 })));
    expect(at[0].firstFrame).toBe(1);
    expect(await collect(recording.query(samples({ kind: 'at', value: 1 })))).toEqual([]);
    const before = await collect(
      recording.query({ kind: 'rows', from: 'Node', select: ['output'], at: 1, count: true }),
    );
    expect(before[0].total).toBe(0);
    const range = await collect(recording.query(samples({ kind: 'range', between: [2, 2] })));
    expect(range.map((block) => block.firstFrame)).toEqual([0, 0, 1, 1]);
    const query = {
      kind: 'aggregate',
      from: 'Node',
      select: ['output'],
      measures: ['min', 'max'],
      window: { kind: 'range', between: [2, 2] },
    } as const;
    const result = await collect(recording.query(query));
    expect(result[0].values.output).toEqual({ count: 8, min: 3, max: 6 });
    expect(
      (await collect(recording.query({ ...query, window: { kind: 'at', value: 1 } })))[0].values
        .output,
    ).toEqual({ count: 0, min: null, max: null });
  });
  it('reports expired coordinate windows and ordered eviction/append notifications', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor({
      ...monitor(),
      retain: { kind: 'rolling', bytes: 80, frames: 2, onLimit: 'fail' },
    });
    const updates: Update[] = [];
    recording.on('change', (update) => updates.push(update));
    model.live(0);
    model.live(1);
    model.live(2);
    expect(updates.slice(-2).map((update) => update.kind)).toEqual(['evict', 'append']);
    expect(updates.at(-2)).toMatchObject({ version: recording.version });
    expect(updates.at(-1)).toMatchObject({ version: recording.version });
    for (const window of [
      { kind: 'at', value: 0 },
      { kind: 'range', between: [0, 1] },
    ] as const)
      await expect(collect(recording.query(samples(window)))).rejects.toMatchObject({
        code: 'expired',
      });
    expect(await collect(recording.query(samples({ kind: 'at', value: -1 })))).toEqual([]);
    const controller = new AbortController();
    recording.readGate = new Promise(() => {});
    const iterator = recording
      .query(samples({ kind: 'frames', offset: 1, count: 1 }), { signal: controller.signal })
      [Symbol.asyncIterator]();
    await iterator.next();
    const pending = expect(iterator.next()).rejects.toMatchObject({ code: 'aborted' });
    await recording.close();
    await pending;
  });
  it.each([false, true])(
    'cancels queued/running work (running=%s) independently from monitoring',
    async (running) => {
      const model = new FixtureModel();
      const recording = await model.monitor(monitor({ kind: 'command', id: 'a' }));
      const controller = new AbortController();
      const promise = model.call(
        { routine: 'solve', values: {} },
        { id: 'a', signal: controller.signal },
      );
      const rejected = expect(promise).rejects.toMatchObject({ code: 'aborted' });
      if (running) model.start('a');
      controller.abort();
      await rejected;
      expect((await recording.commands({ limit: 1 })).items[0].status).toBe('cancelled');
      expect(await recording.done).toEqual({ status: 'stopped', reason: 'command-finished' });
    },
  );
  it('allows command-scoped live routines and ends them before input changes', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(monitor({ kind: 'command', id: 'live' }));
    const promise = model.call({ routine: 'adjust', values: {} }, { id: 'live' });
    const rejected = expect(promise).rejects.toMatchObject({ code: 'aborted' });
    await recording.ready;
    await model.document.edit([{ kind: 'set', id: 'n1', values: { value: 2 } }]);
    await rejected;
    expect(await recording.done).toEqual({ status: 'stopped', reason: 'document-changed' });
  });
});
