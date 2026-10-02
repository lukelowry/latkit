import { renderer as snapshotRenderer } from './fixtures/render.js';
import { it, expect } from 'vitest';
import { createGpu } from '../src/index.js';
import { type Renderer } from '../src/kit.js';
import { HistorySource } from './fixtures/history.js';
import { fakeDevice } from './fixtures/device.js';
import { target, renderer } from './fixtures/render.js';
it('standalone fields preserve borrowed sample backing', async () => {
  const gpu = await createGpu({ device: fakeDevice().device }),
    source = new HistorySource(),
    reads = gpu.reader.open();
  try {
    const iterator = reads
      .fields({
        source: source.data,
        from: 'node',
        fields: { value: 'value' },
        window: { kind: 'range', between: [0, 6] },
      })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done) throw new Error('Expected a native tile');
    expect(first.value.columns.value.kind).toBe('numeric');
    if (first.value.columns.value.kind === 'numeric')
      expect(first.value.columns.value.values.buffer).toBe(source.values.buffer);
    await iterator.return?.();
  } finally {
    reads.close();
  }
  gpu.destroy();
});
it('complete drains bounded renderer submissions and encodes final output once', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  let remaining = 4,
    encodes = 0,
    finishes = 0;
  const view: Renderer = {
    ...snapshotRenderer(
      async () => {},
      () => {
        encodes++;
      },
      () => {
        remaining = Math.max(0, remaining - 1);
      },
    ),
    get pending() {
      return remaining ? Promise.resolve() : undefined;
    },
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
  const reads = gpu.reader.open();
  try {
    const original = [];
    for await (const block of reads.read(source.data, query)) original.push(block);
    const queries = gpu.stats().queries;
    const results = [];
    for await (const block of reads.read({ ...source.data }, query)) results.push(block);
    expect(results).toEqual(original);
    expect(gpu.stats().queries).toBe(queries);
  } finally {
    reads.close();
  }
  gpu.destroy();
});

it('fallback envelopes work on a samples-only source with explicit rows and leading context', async () => {
  const source = new HistorySource(),
    gpu = await createGpu({ device: fakeDevice().device }),
    reads = gpu.reader.open();
  let observed = false;
  try {
    for await (const block of reads.read(source.data, {
      kind: 'envelope',
      from: 'node',
      rows: { kind: 'range', offset: 0, count: 1 },
      select: ['value'],
      window: { kind: 'range', between: [-2, -1], context: { after: 1 } },
      buckets: 1,
    })) {
      observed = true;
      expect(block.columns.value.frames[0]).toBe(source.firstFrame);
      expect(block.columns.value.values.values[0]).toBe(9);
    }
  } finally {
    reads.close();
  }
  expect(observed).toBe(true);
  gpu.destroy();
});
it('invalidates an unchanged rectangle after a later data replacement', async () => {
  const source = new HistorySource(),
    gpu = await createGpu({ device: fakeDevice().device }),
    reads = gpu.reader.open();
  const query = {
    kind: 'samples' as const,
    from: 'node',
    select: ['value'],
    window: { kind: 'frames' as const, offset: source.firstFrame, count: 2 },
  };
  try {
    for await (const block of reads.read(source.data, query)) void block;
    source.publish();
    const previous = gpu.stats().queries;
    for await (const block of reads.read(source.data, query)) void block;
    expect(gpu.stats().queries).toBe(previous + 1);
  } finally {
    reads.close();
  }
  gpu.destroy();
});
