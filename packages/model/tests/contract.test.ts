import { describe, expect, it } from 'vitest';
import type {
  FieldSelection,
  QueryBlock,
  QueryHeader,
  Queryable,
  RowsBlock,
  SamplesBlock,
  SamplesQuery,
  Update,
} from '../src/index.js';
import { blockBuffers, blockByteLength, validateBlock, validateSchema } from '../src/index.js';
import { FixtureModel, collect, failure, readBytes } from './fixture.js';
import { axisLength, axisValues } from './source.js';
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
const solve = { routine: 'solve', values: {} } as const;
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
const first = (block: SamplesBlock): number => {
  const column = block.columns.output;
  return column.values[column.offset];
};
/** The coordinates a samples read covers, one per frame. */
const times = async (source: Queryable, window: SamplesQuery['window']): Promise<number[]> =>
  (await collect(source.query(samples(window))))
    .filter((block) => block.rowOffset === 0)
    .flatMap((block) => [...block.coordinates]);

describe('coherent streams and query semantics', () => {
  it('pins schema with data on first pull, including empty reads', async () => {
    const model = new FixtureModel();
    const stream = model.query(rows)[Symbol.asyncIterator]();
    const header = (await stream.next()).value as QueryHeader;
    expect(header.kind).toBe('schema');
    expect(validateSchema(header.schema)).toEqual([]);
    const original = model.inputs;
    model.replace();
    const remaining: RowsBlock[] = [];
    for (let result = await stream.next(); !result.done; result = await stream.next())
      if (result.value.kind === 'rows') remaining.push(result.value);
    expect(cells(remaining)).toEqual([1, 2, 3, 4]);
    for (const block of remaining) {
      expect(block.version).toBe(header.version);
      expect(block.index).toBe(original.index);
    }
    const empty = [];
    for await (const block of model.query({
      ...rows,
      rows: { kind: 'range', offset: 0, count: 0 },
    }))
      empty.push(block);
    expect(empty).toHaveLength(1);
    expect(empty[0].kind).toBe('schema');
    const counted = await collect(
      model.query({
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
    model.inputs = { ...model.inputs, values: new Float64Array([1, 3, 3, 4]) };
    const query = {
      ...rows,
      where: [{ field: 'value', operator: 'greaterThanOrEqual', value: 2 }] as const,
      orderBy: [{ field: 'value', direction: 'descending' }] as const,
      offset: 1,
      limit: 2,
      count: true,
    };
    const blocks = await collect(model.query(query));
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
          await collect(model.query({ ...rows, where: [{ field: 'value', operator, value }] })),
        ),
      ).toEqual(expected);
    }
    const aggregate = await collect(
      model.query({
        kind: 'aggregate',
        from: 'Node',
        select: ['value'],
        measures: ['min', 'max'],
        rows: { kind: 'ids', ids: ['n1', 'n2'] },
      }),
    );
    expect(aggregate[0].values.value).toEqual({ count: 2, min: 1, max: 3 });
  });
  it('uses pull backpressure, releases early, and pins the first-pull version', async () => {
    const model = new FixtureModel();
    const iterator = model.query(rows)[Symbol.asyncIterator]();
    expect(model.pulls).toBe(0);
    expect((await iterator.next()).value.kind).toBe('schema');
    expect(model.pulls).toBe(0);
    const firstBlock = (await iterator.next()).value as QueryBlock;
    expect(model.pulls).toBe(1);
    model.replace(new Float64Array([9, 9, 9, 9]));
    const second = (await iterator.next()).value as QueryBlock;
    expect(second.version).toBe(firstBlock.version);
    await iterator.return?.();
    expect(model.released).toBe(1);
    expect((await collect(model.query(rows)))[0].version).not.toBe(firstBlock.version);
    const early = model.query(rows)[Symbol.asyncIterator]();
    await early.next();
    const before = model.pulls;
    await early.return?.();
    expect(model.pulls).toBe(before);
    expect(model.released).toBe(3);
  });
  it('borrows contiguous data, gathers sparse data, and gives owned callers independent buffers', async () => {
    const model = new FixtureModel();
    const borrowed = await collect(model.query(rows));
    expect(blockBuffers(borrowed[0])).toContain(model.inputs.values.buffer);
    expect(model.copiedBytes).toBe(0);
    const sparse = await collect(
      model.query({
        ...rows,
        rows: { kind: 'indices', index: model.inputs.index, values: new Uint32Array([3, 0]) },
      }),
    );
    expect(model.copiedBytes).toBe(16);
    expect(sparse[0].columns.value.kind).toBe('numeric');
    const owned = await collect(model.query(rows, { buffers: 'owned' }));
    expect(blockBuffers(owned[0])).not.toContain(model.inputs.values.buffer);
    structuredClone(owned[0], { transfer: blockBuffers(owned[0]) as ArrayBuffer[] });
    expect(model.inputs.values.byteLength).toBe(32);
    expect(blockBuffers(owned[1]).every((buffer) => buffer.byteLength > 0)).toBe(true);
    expect(blockByteLength(borrowed[0])).toBeLessThan(4096);
  });
  it('uses ranges without identity allocation and compacts owned allocations to the byte bound', async () => {
    const model = new FixtureModel();
    model.inputs = {
      ...model.inputs,
      values: new Float64Array(new ArrayBuffer(1024 * 1024), 0, 4),
    };
    const borrowed = await collect(model.query(rows));
    expect(borrowed[0].rows).toEqual({ kind: 'range', offset: 0, count: 2 });
    expect(model.copiedBytes).toBe(0);
    const bound = blockByteLength(borrowed[0]);
    expect(
      validateBlock(await model.describe(), rows, borrowed[0], {
        buffers: 'owned',
        maxBlockBytes: bound,
      }),
    ).toMatchObject([{ code: 'resource-limit' }]);
    const owned = await collect(model.query(rows, { buffers: 'owned', maxBlockBytes: bound }));
    expect(model.copiedBytes).toBe(32);
    for (const block of owned) {
      expect(blockBuffers(block).reduce((total, buffer) => total + buffer.byteLength, 0)).toBe(16);
      expect(
        validateBlock(await model.describe(), rows, block, {
          buffers: 'owned',
          maxBlockBytes: bound,
        }),
      ).toEqual([]);
    }
  });
  it('rejects a stale index after its file is replaced, and never reuses identities', async () => {
    const model = new FixtureModel();
    const original = model.inputs;
    model.replace();
    const ids = [...original.ids, ...model.inputs.ids];
    expect(new Set(ids).size).toBe(ids.length);
    await expect(
      collect(
        model.query({
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
      model.readGate = new Promise(() => {});
      const iterator = model.query(rows, { signal: controller.signal })[Symbol.asyncIterator]();
      await iterator.next();
      const pending = iterator.next();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
      if (action === 'abort') controller.abort();
      else await model.close();
      await rejected;
      expect(model.released).toBe(1);
      expect(model.pulls).toBe(0);
    },
  );
});

describe('monitors', () => {
  it('declares sampled fields on the model and reads them only through a monitor', async () => {
    const model = new FixtureModel();
    const schema = await model.describe();
    expect(schema.types.Node.fields.output).toMatchObject({ sampled: true });
    expect(schema.axis).toBeUndefined();
    const recording = await model.monitor(output);
    const recorded = await recording.describe();
    expect(validateSchema(recorded)).toEqual([]);
    expect(recorded.axis).toEqual({ name: 'time', unit: 's' });
    expect(Object.keys(recorded.types.Node.fields)).toEqual(['value', 'output']);
  });
  it('starts idle, then streams every command that starts after it opened', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    expect(recording.status).toBe('idle');
    expect(recording.frames).toBe(0);
    expect(recording.range).toBeNull();
    const updates: Update['kind'][] = [];
    recording.on('change', (update) => updates.push(update.kind));
    const command = model.run(solve);
    expect(recording.status).toBe('running');
    model.frame(0);
    model.frame(1);
    const late = await model.monitor(output);
    model.frame(2);
    model.finish();
    expect(await command).toEqual({ frames: 3 });
    expect(recording.status).toBe('complete');
    expect(recording.frames).toBe(3);
    expect(recording.range).toEqual([0, 2]);
    expect(updates).toEqual(['replace', 'status', 'append', 'append', 'append', 'status']);
    expect(late.status).toBe('idle');
    expect(late.frames).toBe(0);
  });
  it('starts over for each command, while retain() keeps one past the next', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const earlier = model.run(solve);
    model.frame(0);
    model.frame(1);
    model.finish();
    await earlier;
    const kept = await recording.retain();
    const later = model.run(solve);
    expect(recording.frames).toBe(0);
    model.frame(5);
    model.finish();
    await later;
    expect(await times(recording, { kind: 'frames', offset: 0, count: 1 })).toEqual([5]);
    expect(await times(kept, { kind: 'frames', offset: 0, count: 2 })).toEqual([0, 1]);
    await kept.close();
    expect(model.retention.bytes).toBe(0);
  });
  it('runs commands one at a time, in the order given', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const earlier = model.run(solve);
    const later = model.run(solve);
    model.frame(0);
    model.finish();
    expect(await earlier).toEqual({ frames: 1 });
    expect(recording.status).toBe('running');
    expect(recording.frames).toBe(0);
    model.frame(7);
    model.frame(8);
    model.finish();
    expect(await later).toEqual({ frames: 2 });
    expect(recording.range).toEqual([7, 8]);
  });
  it.each([false, true])('cancels a queued or running command (running=%s)', async (running) => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const ahead = running ? undefined : model.run(solve);
    const controller = new AbortController();
    const command = model.run(solve, { signal: controller.signal });
    model.frame(0);
    controller.abort();
    await expect(command).rejects.toMatchObject({ code: 'aborted' });
    if (running) {
      expect(recording.status).toBe('cancelled');
      expect(await times(recording, { kind: 'frames', offset: 0, count: 1 })).toEqual([0]);
    } else {
      expect(recording.status).toBe('running');
      model.finish();
      expect(await ahead).toEqual({ frames: 1 });
      expect(recording.status).toBe('complete');
    }
    expect(model.queue).toHaveLength(0);
  });
  it('rejects an unknown routine, with issues, before anything runs', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    await expect(model.run({ routine: 'missing', values: {} })).rejects.toMatchObject({
      code: 'invalid-input',
      issues: [{ target: { kind: 'path', path: ['routine'] } }],
    });
    expect(recording.status).toBe('idle');
    expect(model.queue).toHaveLength(0);
  });
  it('leaves monitors as they are for routines that do not record', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const solved = model.run(solve);
    model.frame(0);
    model.finish();
    await solved;
    const version = recording.version;
    const checked = model.run({ routine: 'check', values: {} });
    model.finish();
    expect(await checked).toEqual({ frames: 0 });
    expect(recording.version).toBe(version);
    expect(recording.status).toBe('complete');
  });
  it('fails its monitors, and says why, when a command fails', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const command = model.run(solve);
    model.frame(0);
    model.finish(failure('internal', 'The solver diverged.'));
    await expect(command).rejects.toMatchObject({ code: 'internal' });
    expect(recording.status).toBe('failed');
    expect(recording.frames).toBe(1);
    expect(recording.diagnostics).toEqual([
      { code: 'internal', message: 'The solver diverged.', severity: 'error' },
    ]);
  });
  it('runs on the data current as it starts; a later replacement never reaches it', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const command = model.run(solve);
    model.replace(new Float64Array([10, 20, 30, 40]));
    model.frame(0);
    model.finish();
    await command;
    const frame = await collect(recording.query(samples({ kind: 'frames', offset: 0, count: 1 })));
    expect(frame.flatMap((block) => [...block.columns.output.values])).toEqual([1, 2, 3, 4]);
    expect(cells(await collect(recording.query(rows)))).toEqual([1, 2, 3, 4]);
  });
  it('rejects fields that are unknown or not sampled, and rows it cannot resolve', async () => {
    const model = new FixtureModel();
    for (const fields of [
      [],
      [{ from: 'Node', select: ['missing'] }],
      [{ from: 'Node', select: ['value'] }],
      [{ from: 'Node', select: ['output'], rows: { kind: 'ids', ids: ['n9'] } }],
    ] as const)
      await expect(model.monitor(fields)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(model.monitors.size).toBe(0);
  });
  it('resolves each field selection once and reads their physical-order intersection', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor([
      { from: 'Node', select: ['output'], rows: { kind: 'ids', ids: ['n4', 'n2', 'n3'] } },
      { from: 'Node', select: ['other'], rows: { kind: 'range', offset: 2, count: 2 } },
    ]);
    const command = model.run(solve);
    model.frame(0);
    model.finish();
    await command;
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
    const recording = await model.monitor(output);
    const command = model.run(solve);
    model.frame(2);
    model.frame(2);
    model.frame(5);
    model.finish();
    await command;
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
  it('tiles a long recording exactly once, with borrowed blocks that outlive it', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const command = model.run(solve);
    model.frame(0);
    const old = (
      await collect(recording.query(samples({ kind: 'frames', offset: 0, count: 1 })))
    )[0];
    for (let t = 1; t < 1000; t++) model.frame(t);
    model.finish();
    await command;
    expect(recording.frames).toBe(1000);
    const query = samples({ kind: 'frames', offset: 998, count: 2 });
    const tiles = await collect(recording.query(query, { maxBlockBytes: 1024 }));
    const covered = new Set<string>();
    for (const tile of tiles) {
      expect(
        validateBlock(await recording.describe(), query, tile, { maxBlockBytes: 1024 }),
      ).toEqual([]);
      for (let i = 0; i < tile.coordinates.length; i++)
        for (let j = 0; j < axisLength(tile.rows); j++) {
          const cell = tile.firstFrame + i + ':' + (tile.rowOffset + j);
          expect(covered.has(cell)).toBe(false);
          covered.add(cell);
        }
    }
    expect(covered.size).toBe(8);
    expect(recording.copiedBytes).toBe(0);
    await recording.close();
    expect(first(old)).toBe(1);
    await expect(collect(recording.query(query))).rejects.toMatchObject({ code: 'closed' });
  });
  it('ends its stream when it closes, never the command', async () => {
    const model = new FixtureModel();
    const closing = await model.monitor(output);
    const staying = await model.monitor(output);
    const command = model.run(solve);
    model.frame(0);
    const changes: Update['kind'][] = [];
    closing.on('change', (update) => changes.push(update.kind));
    await closing.close();
    model.frame(1);
    model.finish();
    expect(await command).toEqual({ frames: 2 });
    expect(staying.frames).toBe(2);
    expect(changes).toEqual(['closed']);
    await expect(closing.describe()).rejects.toMatchObject({ code: 'closed' });
  });
  it('keeps what it recorded when its model closes, which cancels the command', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const command = model.run(solve);
    model.frame(0);
    await model.close();
    await expect(command).rejects.toMatchObject({ code: 'aborted' });
    expect(recording.status).toBe('cancelled');
    expect(await times(recording, { kind: 'frames', offset: 0, count: 1 })).toEqual([0]);
    await expect(model.monitor(output)).rejects.toMatchObject({ code: 'closed' });
    await expect(model.run(solve)).rejects.toMatchObject({ code: 'closed' });
  });
  it('exports the frames it holds', async () => {
    const model = new FixtureModel();
    const recording = await model.monitor(output);
    const command = model.run(solve);
    model.frame(0);
    model.finish();
    await command;
    const exported = await recording.export();
    expect(exported.version).toBe(recording.version);
    expect(JSON.parse(new TextDecoder().decode(await readBytes(exported.stream)))).toEqual({
      inputs: [1, 2, 3, 4],
      frames: [[0, { output: [1, 2, 3, 4] }]],
    });
  });
});
