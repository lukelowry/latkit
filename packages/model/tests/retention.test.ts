import { describe, expect, it } from 'vitest';
import type { FieldSelection, Queryable, SampleWindow } from '../src/index.js';
import { FixtureModel, collect } from './fixture.js';
import { ScaleModel } from './scale/model.js';
import { RetainedBudget } from './retention.js';
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const samples = (window: SampleWindow) => ({
  kind: 'samples' as const,
  from: 'Node',
  select: ['output'],
  window,
});
const coordinates = async (source: Queryable, window: SampleWindow) =>
  (await collect(source.query(samples(window))))
    .filter((b) => b.rowOffset === 0)
    .flatMap((b) => [...b.coordinates]);

describe('retained Queryable', () => {
  it('pins input values and row identity across replacement and closure; nested retains are independent', async () => {
    const model = new FixtureModel();
    const source = await model.retain(),
      nested = await source.retain();
    const initial = source.version;
    model.replace(new Float64Array([99, 98, 97, 96]));
    await model.close();
    await source.close();
    const blocks = await collect(nested.query(rows));
    expect(blocks[0].version).toBe(initial);
    expect(blocks[0].columns.value).toMatchObject({ values: new Float64Array([1, 2]) });
    await expect(source.describe()).rejects.toMatchObject({ code: 'closed' });
    await nested.close();
    expect(model.retention.bytes).toBe(0);
  });
  it('resolves context once, keeps native backing past the next command, and rejects queries outside its grant', async () => {
    const model = new FixtureModel(),
      recording = await model.monitor(output);
    const command = model.run({ routine: 'solve', values: {} });
    for (const t of [0, 1, 1, 2, 3]) model.frame(t);
    model.finish();
    await command;
    const window = {
      kind: 'range',
      between: [1.5, 1.5],
      context: { before: 1, after: 1 },
    } as const;
    const source = await recording.retain({ window });
    const changes: string[] = [];
    source.on('change', (c) => changes.push(c.kind));
    const original = recording.stateForRead().frames![2].values.output.buffer;
    const block = (
      await collect(source.query(samples({ kind: 'frames', offset: 2, count: 1 })))
    )[0];
    expect(block.columns.output.values.buffer).toBe(original);
    const version = source.version;
    const next = model.run({ routine: 'solve', values: {} });
    for (let t = 4; t < 12; t++) model.frame(t);
    model.finish();
    await next;
    await model.close();
    await recording.close();
    expect(source.version).toBe(version);
    expect(await coordinates(source, window)).toEqual([1, 2]);
    await expect(coordinates(source, { kind: 'range', between: [1, 2] })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(coordinates(source, { kind: 'at', value: 0 })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    const nested = await source.retain({ window: { kind: 'frames', offset: 3, count: 1 } });
    await expect(
      source.retain({ window: { kind: 'frames', offset: 0, count: 1 } }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await source.close();
    expect(changes).toEqual(['closed']);
    expect(await coordinates(nested, { kind: 'at', value: 2 })).toEqual([2]);
    await nested.close();
    expect(model.retention.bytes).toBe(0);
    expect(block.columns.output.values[0]).toBe(2);
  });
  it('does not expand empty acquired coverage when a command appends', async () => {
    const model = new FixtureModel(),
      recording = await model.monitor(output),
      source = await recording.retain();
    const command = model.run({ routine: 'solve', values: {} });
    model.frame(0);
    expect(await coordinates(source, { kind: 'range', between: [0, 1] })).toEqual([]);
    await expect(
      coordinates(source, { kind: 'frames', offset: 0, count: 1 }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    model.finish();
    await command;
    await source.close();
    await recording.close();
    await model.close();
  });
  it('charges complete native backing for a sparse monitor and unwinds rejected admissions', async () => {
    const model = new FixtureModel(),
      recording = await model.monitor([
        { from: 'Node', select: ['output'], rows: { kind: 'range', offset: 0, count: 1 } },
      ]);
    const command = model.run({ routine: 'solve', values: {} });
    model.frame(0);
    model.finish();
    await command;
    await expect(recording.retain({ maxBytes: 24 })).rejects.toMatchObject({
      code: 'resource-limit',
    });
    expect(model.retention.bytes).toBe(0);
    const signal = AbortSignal.abort();
    await expect(recording.retain({ signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(model.retention.bytes).toBe(0);
    await expect(model.retain({ window: { kind: 'at', value: 0 } })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(recording.retain({ maxBytes: Infinity })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await recording.close();
    await model.close();
  });
  it('admits million-row inputs lazily, deduplicates shared reservations, and enforces a budget', async () => {
    const bytes = 1_000_003 * 8,
      budget = new RetainedBudget(bytes + 64, bytes + 64);
    const model = new ScaleModel(1_000_003, 8192, budget);
    const source = await model.retain(),
      other = await source.retain();
    expect(model.stats.generatedBytes).toBe(0);
    expect(model.stats.blocks).toBe(0);
    expect(budget.bytes).toBe(bytes);
    const second = new ScaleModel(1_000_003, 8192, budget);
    await expect(second.retain()).rejects.toMatchObject({ code: 'resource-limit' });
    await model.close();
    await source.close();
    expect(budget.bytes).toBe(bytes);
    await other.close();
    expect(budget.bytes).toBe(0);
    await second.close();
    expect(model.stats.acquisitions).toBe(0);
  });
  it('cancels direct pending reads without releasing a nested retained acquisition', async () => {
    const model = new ScaleModel(1000),
      source = await model.retain(),
      child = await source.retain();
    const iterator = source.query(rows)[Symbol.asyncIterator]();
    await iterator.next();
    model.pause(true);
    const pending = iterator.next();
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await source.close();
    await cancelled;
    model.pause(false);
    expect((await collect(child.query(rows))).length).toBeGreaterThan(0);
    await model.close();
    await child.close();
    expect(model.stats.activeReads).toBe(0);
    expect(model.stats.acquisitions).toBe(0);
    expect(model.retention.bytes).toBe(0);
  });
  it('uses acquisition cancellation only during admission', async () => {
    const model = new FixtureModel(),
      controller = new AbortController();
    const source = await model.retain({ signal: controller.signal });
    controller.abort();
    expect((await collect(source.query(rows))).length).toBe(2);
    await source.close();
    await model.close();
  });
});
