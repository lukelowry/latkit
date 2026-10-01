import { it, expect } from 'vitest';
import { createGpu, type Renderer } from '../src/index.js';
import { HistorySource } from './fixtures/history.js';
import { fakeDevice } from './fixtures/device.js';
import { target, renderer } from './fixtures/render.js';
it('standalone fields preserve authoritative versions and borrowed sample backing', async () => {
  const gpu = await createGpu({ device: fakeDevice().device }),
    source = new HistorySource();
  const iterator = gpu
    .fields({
      source,
      from: 'node',
      fields: { value: 'value' },
      window: { kind: 'range', between: [0, 6] },
    })
    [Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  if (first.done) throw new Error('Expected a native tile');
  expect(first.value.versions.get(source)).toBe(source.version);
  expect(first.value.columns.value.kind).toBe('numeric');
  if (first.value.columns.value.kind === 'numeric')
    expect(first.value.columns.value.values.buffer).toBe(source.values.buffer);
  await iterator.return?.();
  gpu.destroy();
});
it('complete drains bounded renderer submissions and encodes final output once', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  let remaining = 4,
    encodes = 0,
    finishes = 0;
  const view: Renderer = {
    get pending() {
      return remaining ? Promise.resolve() : undefined;
    },
    async prepare() {},
    encode() {
      encodes++;
    },
    submitted() {
      remaining = Math.max(0, remaining - 1);
    },
    destroy() {},
  };
  await gpu.render({
    views: [{ renderer: view, target: target(fake.device) }],
    timeMs: 0,
    completion: 'complete',
    encode() {
      finishes++;
    },
  });
  expect(remaining).toBe(0);
  expect(encodes).toBe(5);
  expect(finishes).toBe(1);
  gpu.destroy();
});
it('complete rendering can abort while waiting without submitting unfinished output', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    stop = new AbortController();
  let finish = 0;
  const view: Renderer = { ...renderer(() => {}), pending: new Promise(() => {}) };
  const task = gpu.render({
    views: [{ renderer: view, target: target(fake.device) }],
    timeMs: 0,
    completion: 'complete',
    signal: stop.signal,
    encode() {
      finish++;
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  stop.abort();
  await expect(task).rejects.toMatchObject({ name: 'AbortError' });
  expect(finish).toBe(0);
  gpu.destroy();
});
it('reuses a completed frame rectangle after an unrelated append', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    source = new HistorySource(),
    query = {
      kind: 'samples' as const,
      from: 'node',
      select: ['value'],
      window: { kind: 'frames' as const, offset: source.firstFrame, count: 2 },
    };
  for await (const block of gpu.query(source, query)) {
    expect(block.version).toBe(source.version);
  }
  const reads = source.requests.length;
  source.version = 'v1';
  for (const fn of source.listeners)
    fn({ kind: 'append', version: 'v1', frames: { offset: source.firstFrame + 7, count: 1 } });
  const results = [];
  for await (const block of gpu.query(source, query)) results.push(block);
  expect(source.requests.length).toBe(reads);
  expect(results.every((block) => block.version === 'v1')).toBe(true);
  gpu.destroy();
});

it('fallback envelopes work on a samples-only source with explicit rows and leading context', async () => {
  class SamplesOnly extends HistorySource {
    override get schema() {
      return { ...super.schema, queries: ['samples' as const] };
    }
  }
  const source = new SamplesOnly(),
    gpu = await createGpu({ device: fakeDevice().device });
  let observed = false;
  for await (const block of gpu.envelope({
    source,
    query: {
      kind: 'envelope',
      from: 'node',
      rows: { kind: 'range', offset: 0, count: 1 },
      select: ['value'],
      window: { kind: 'range', between: [-2, -1], context: { after: 1 } },
      buckets: 1,
    },
  })) {
    observed = true;
    expect(block.columns.value.frames[0]).toBe(source.firstFrame);
    expect(block.columns.value.values.values[0]).toBe(9);
  }
  expect(observed).toBe(true);
  gpu.destroy();
});
it('invalidates an unchanged rectangle after a later data replacement', async () => {
  const source = new HistorySource(),
    gpu = await createGpu({ device: fakeDevice().device });
  const query = {
    kind: 'samples' as const,
    from: 'node',
    select: ['value'],
    window: { kind: 'frames' as const, offset: source.firstFrame, count: 2 },
  };
  for await (const block of gpu.query(source, query)) {
    expect(block.version).toBe('v0');
  }
  source.version = 'v1';
  for (const fn of source.listeners)
    fn({ kind: 'append', version: 'v1', frames: { offset: source.firstFrame + 7, count: 1 } });
  source.version = 'v2';
  for (const fn of source.listeners) fn({ kind: 'replace', version: 'v2' });
  const previous = source.requests.length;
  for await (const block of gpu.query(source, query)) {
    expect(block.version).toBe('v2');
  }
  expect(source.requests.length).toBe(previous + 1);
  gpu.destroy();
});
