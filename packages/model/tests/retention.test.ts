import { describe, expect, it } from 'vitest';
import type { MonitorConfig, Queryable, SampleWindow } from '../src/index.js';
import { FixtureService, FixtureModel, collect } from './fixture.js';
import { ScaleService } from './scale/service.js';
import { RetainedBudget } from './retention.js';
const monitor: MonitorConfig = {
  scope: { kind: 'live' },
  fields: [{ from: 'Node', select: ['output'] }],
  retain: { kind: 'rolling', bytes: 120, frames: 3, onLimit: 'fail' },
};
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

describe('independent recording acquisitions', () => {
  it('reacquires shared data, closes one handle, and stops capture through another', async () => {
    const service = new FixtureService(),
      document = await service.open(),
      model = await service.model(document.id);
    const first = await model.monitor(monitor),
      second = await service.recording(first.id);
    expect(second.modelId).toBe(model.id);
    const changes: string[] = [];
    first.on('change', (c) => changes.push(c.kind));
    await first.close();
    await expect(first.done).rejects.toMatchObject({ code: 'closed' });
    model.live(10);
    expect(second.frameCount).toBe(1);
    await second.stop();
    expect(await second.done).toEqual({ status: 'stopped', reason: 'requested' });
    await model.close();
    await document.close();
    expect(await coordinates(second, { kind: 'at', value: 10 })).toEqual([10]);
    await second.close();
    await expect(service.recording(first.id)).rejects.toMatchObject({ code: 'closed' });
    expect(changes).toEqual(['closed']);
  });
  it('rejects only the released armed handle and preserves settled outcomes', async () => {
    const service = new FixtureService(),
      document = await service.open(),
      model = await service.model(document.id);
    const first = await model.monitor({ ...monitor, scope: { kind: 'command', id: 'a' } });
    const second = await service.recording(first.id);
    await first.close();
    await expect(first.ready).rejects.toMatchObject({ code: 'closed' });
    await expect(first.done).rejects.toMatchObject({ code: 'closed' });
    const command = model.call({ routine: 'solve', values: {} }, { id: 'a' });
    await second.ready;
    model.complete('a');
    await command;
    const outcome = await second.done;
    await second.close();
    await expect(second.ready).resolves.toBeUndefined();
    expect(await second.done).toBe(outcome);
    await model.close();
    await document.close();
  });
  it.each(['reset', 'close'] as const)(
    'ends production on Model.%s without waiting for or disposing readers',
    async (action) => {
      const model = new FixtureModel(),
        recording = await model.monitor(monitor);
      model.live(0);
      const iterator = recording.query(samples({ kind: 'at', value: 0 }))[Symbol.asyncIterator]();
      await iterator.next();
      recording.source.readGate = new Promise(() => undefined);
      const pending = iterator.next();
      const interrupted = expect(pending).rejects.toMatchObject({ code: 'aborted' });
      await model[action]();
      expect(await recording.done).toEqual({
        status: 'stopped',
        reason: action === 'reset' ? 'model-reset' : 'model-closed',
      });
      expect(recording.source.released).toBe(0);
      await recording.close();
      await interrupted;
      await model.close();
    },
  );
  it('ends capture at the last acquisition while retained data remains usable', async () => {
    const service = new FixtureService(),
      doc = await service.open(),
      model = await service.model(doc.id);
    const recording = await model.monitor(monitor);
    model.live(0);
    const source = await recording.retain();
    await recording.close();
    expect(await recording.source.done).toEqual({ status: 'stopped', reason: 'released' });
    await expect(service.recording(recording.id)).rejects.toMatchObject({ code: 'closed' });
    await model.close();
    await doc.close();
    expect(await coordinates(source, { kind: 'at', value: 0 })).toEqual([0]);
    await source.close();
    expect(service.retention.bytes).toBe(0);
  });
});

describe('retained Queryable', () => {
  it('pins input values and row identity across edits, replacement and closure; nested retains are independent', async () => {
    const model = new FixtureModel();
    const source = await model.document.retain(),
      nested = await source.retain();
    const initial = source.version;
    await model.document.edit!([{ kind: 'set', id: 'n1', values: { value: 99 } }]);
    await model.document.replace();
    await model.close();
    await source.close();
    const blocks = await collect(nested.query(rows));
    expect(blocks[0].version).toBe(initial);
    expect(blocks[0].columns.value).toMatchObject({ values: new Float64Array([1, 2]) });
    await expect(source.describe()).rejects.toMatchObject({ code: 'closed' });
    await nested.close();
    expect(model.document.retention.bytes).toBe(0);
  });
  it('resolves context once, retains native backing through eviction, and rejects queries outside its grant', async () => {
    const model = new FixtureModel(),
      recording = await model.monitor({
        ...monitor,
        retain: { kind: 'rolling', bytes: 200, frames: 5, onLimit: 'fail' },
      });
    for (const t of [0, 1, 1, 2, 3]) model.live(t);
    const window = {
      kind: 'range',
      between: [1.5, 1.5],
      context: { before: 1, after: 1 },
    } as const;
    const source = await recording.retain({ window });
    const changes: string[] = [];
    source.on('change', (c) => changes.push(c.kind));
    const original = recording.source.stateForRead().frames![2].values.output.buffer;
    const block = (
      await collect(source.query(samples({ kind: 'frames', offset: 2, count: 1 })))
    )[0];
    expect(block.columns.output.values.buffer).toBe(original);
    const version = source.version;
    for (let t = 4; t < 12; t++) model.live(t);
    await model.reset();
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
    expect(model.document.retention.bytes).toBe(0);
    expect(block.columns.output.values[0]).toBe(2);
  });
  it('does not expand empty acquired coverage when capture appends', async () => {
    const model = new FixtureModel(),
      recording = await model.monitor(monitor),
      source = await recording.retain();
    model.live(0);
    expect(await coordinates(source, { kind: 'range', between: [0, 1] })).toEqual([]);
    await expect(
      coordinates(source, { kind: 'frames', offset: 0, count: 1 }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await source.close();
    await recording.close();
    await model.close();
  });
  it('charges complete native backing for sparse capture and unwinds rejected admissions', async () => {
    const model = new FixtureModel(),
      recording = await model.monitor({
        ...monitor,
        fields: [
          { from: 'Node', select: ['output'], rows: { kind: 'range', offset: 0, count: 1 } },
        ],
      });
    model.live(0);
    await expect(recording.retain({ maxBytes: 24 })).rejects.toMatchObject({
      code: 'resource-limit',
    });
    expect(model.document.retention.bytes).toBe(0);
    const signal = AbortSignal.abort();
    await expect(recording.retain({ signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(model.document.retention.bytes).toBe(0);
    await expect(model.document.retain({ window: { kind: 'at', value: 0 } })).rejects.toMatchObject(
      { code: 'invalid-input' },
    );
    await expect(recording.retain({ maxBytes: Infinity })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await recording.close();
    await model.close();
  });
  it('admits million-row inputs lazily, deduplicates shared reservations, and enforces a service-wide limit', async () => {
    const bytes = 1_000_003 * 8,
      budget = new RetainedBudget(bytes + 64, bytes + 64);
    const service = new ScaleService(1_000_003, 8192, budget),
      doc = await service.open();
    const source = await doc.retain(),
      other = await source.retain();
    expect(service.stats.generatedBytes).toBe(0);
    expect(service.stats.blocks).toBe(0);
    expect(budget.bytes).toBe(bytes);
    const second = await service.open();
    await expect(second.retain()).rejects.toMatchObject({ code: 'resource-limit' });
    await doc.close();
    await source.close();
    expect(budget.bytes).toBe(bytes);
    await other.close();
    expect(budget.bytes).toBe(0);
    await second.close();
    expect(service.cores.size).toBe(0);
    expect(service.stats.acquisitions).toBe(0);
  });
  it('cancels direct pending reads without releasing a nested retained acquisition', async () => {
    const service = new ScaleService(1000),
      doc = await service.open(),
      source = await doc.retain(),
      child = await source.retain();
    const iterator = source.query(rows)[Symbol.asyncIterator]();
    await iterator.next();
    service.pause(true);
    const pending = iterator.next();
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await source.close();
    await cancelled;
    service.pause(false);
    expect((await collect(child.query(rows))).length).toBeGreaterThan(0);
    await doc.close();
    await child.close();
    expect(service.stats.activeReads).toBe(0);
    expect(service.stats.acquisitions).toBe(0);
    expect(service.retention.bytes).toBe(0);
  });
  it('uses acquisition cancellation only during admission', async () => {
    const model = new FixtureModel(),
      controller = new AbortController();
    const source = await model.document.retain({ signal: controller.signal });
    controller.abort();
    expect((await collect(source.query(rows))).length).toBe(2);
    await source.close();
    await model.close();
  });
});
