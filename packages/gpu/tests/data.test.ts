import { describe, expect, it } from 'vitest';
import type { Query, Queryable, QueryHeader, QueryBlock } from '@latkit/model';
import { createGpu, type Preparation } from '../src/index.js';
import { deferred, fakeDevice } from './fixtures/device.js';
import { draw, renderer, target } from './fixtures/render.js';
import { Source } from './fixtures/source.js';

const rows = { kind: 'rows', from: 'node', select: ['value'] } as const;
const collect = async (frame: Preparation, source: Queryable, query: Query = rows) => {
  const result: (QueryHeader | QueryBlock)[] = [];
  for await (const block of frame.query(source, query)) result.push(block);
  return result;
};

describe('native query preparation', () => {
  it('coalesces equivalent concurrent reads and replays a completed query', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device, validate: true });
    const source = new Source(30, { blockRows: 10 });
    const left: unknown[] = [],
      right: unknown[] = [];
    await gpu.render({
      timeMs: 0,
      views: [
        {
          renderer: renderer(async (frame) => {
            left.push(...(await collect(frame, source)));
          }),
          target: target(fake.device),
        },
        {
          renderer: renderer(async (frame) => {
            right.push(
              ...(await collect(frame, source, { select: ['value'], from: 'node', kind: 'rows' })),
            );
          }),
          target: target(fake.device),
        },
      ],
    });
    expect(source.reads).toBe(1);
    expect(left).toEqual(right);
    expect(left[1]).toBe(right[1]);
    await draw(gpu, async (frame) => {
      expect(await collect(frame, source)).toEqual(left);
    });
    expect(source.reads).toBe(1);
    expect(gpu.stats().queryHits).toBe(2);
    gpu.destroy();
    expect(source.closes).toBe(0);
    expect(source.listeners.size).toBe(0);
  });

  it('streams a query larger than the cache without collecting the full result', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({
        device: fake.device,
        budget: { cpuBytes: 8192, stagingBytes: 4096, entries: 24 },
        maxBlockBytes: 1024,
      });
    const source = new Source(20000, { blockRows: 64 });
    let count = 0;
    await draw(gpu, async (frame) => {
      for await (const block of frame.query(source, rows))
        if (block.kind === 'rows')
          count += block.rows.kind === 'range' ? block.rows.count : block.rows.values.length;
    });
    expect(count).toBe(20000);
    expect(source.reads).toBe(1);
    expect(gpu.stats().peakCpuBytes).toBeLessThanOrEqual(8192);
    expect(gpu.stats().evictions).toBeGreaterThan(0);
    expect(source.ended).toBe(1);
    gpu.destroy();
  });

  it('bounds a tiny borrowed slice that otherwise retains a large allocation', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({
        device: fake.device,
        budget: { cpuBytes: 4096, stagingBytes: 4096 },
      });
    const source = new Source(100000, { blockRows: 2 });
    await draw(gpu, async (frame) => {
      const result = await collect(frame, source, {
        ...rows,
        rows: { kind: 'range', offset: 20, count: 2 },
      });
      const block = result[1];
      if (block.kind !== 'rows' || block.columns.value.kind !== 'numeric')
        throw new Error('Expected rows');
      expect(block.columns.value.values.buffer.byteLength).toBe(8);
      expect([...block.columns.value.values]).toEqual([20, 21]);
    });
    expect(gpu.stats().peakCpuBytes).toBeLessThanOrEqual(4096);
    gpu.destroy();
  });

  it('does not reuse a cache across distinct acquisitions with equal version strings', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const a = new Source(),
      b = new Source();
    b.values = new Float32Array(16).fill(77);
    await draw(gpu, async (frame) => {
      await collect(frame, a);
      const result = await collect(frame, b);
      const block = result[1];
      if (block.kind === 'rows' && block.columns.value.kind === 'numeric')
        expect(block.columns.value.values[0]).toBe(77);
    });
    expect(a.reads).toBe(1);
    expect(b.reads).toBe(1);
    gpu.destroy();
  });

  it('invalidates published data without closing the original source', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const source = new Source();
    await draw(gpu, async (frame) => {
      await collect(frame, source);
    });
    source.publish();
    await draw(gpu, async (frame) => {
      await collect(frame, source);
    });
    expect(source.reads).toBe(2);
    gpu.destroy();
    expect(source.closes).toBe(0);
  });

  it('cancels one coalesced consumer without cancelling another', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const source = new Source();
    const gate = deferred<void>();
    source.gate = gate.promise;
    const abort = new AbortController();
    const first = gpu.render({
      timeMs: 0,
      signal: abort.signal,
      views: [
        {
          renderer: renderer(async (frame) => {
            await collect(frame, source);
          }),
          target: target(fake.device),
        },
      ],
    });
    const failure = expect(first).rejects.toBe('cancel first');
    const second = gpu.render({
      timeMs: 0,
      views: [
        {
          renderer: renderer(async (frame) => {
            await collect(frame, source);
          }),
          target: target(fake.device),
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort('cancel first');
    await failure;
    gate.resolve();
    await second;
    expect(source.reads).toBe(1);
    expect(source.ended).toBe(1);
    expect(fake.queue.submit).toHaveBeenCalledTimes(1);
    gpu.destroy();
  });

  it('interrupts a pending read on owner destruction without closing its source', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const source = new Source();
    source.gate = new Promise(() => {});
    const pending = draw(gpu, async (frame) => {
      await collect(frame, source);
    });
    const failure = expect(pending).rejects.toMatchObject({ code: 'closed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    gpu.destroy();
    await failure;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.ended).toBe(1);
    expect(source.closes).toBe(0);
    expect(source.listeners.size).toBe(0);
    expect(gpu.stats().cpuBytes).toBe(0);
  });

  it('renders a coherent immutable read while a live source publishes newer data', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const source = new Source();
    await draw(gpu, async (frame) => {
      await collect(frame, source);
      source.publish();
    });
    expect(fake.queue.submit).toHaveBeenCalledTimes(1);
    gpu.destroy();
  });

  it('rejects mixed versions within a query and does not cache the failure', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const source = new Source();
    const native = source.query;
    const query = (request: Query) => ({
      async *[Symbol.asyncIterator]() {
        for await (const block of native(request))
          yield block.kind === 'schema' ? block : { ...block, version: 'wrong' };
      },
    });
    source.query = query as Queryable['query'];
    await expect(
      draw(gpu, async (frame) => {
        await collect(frame, source);
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    source.query = native;
    await draw(gpu, async (frame) => {
      await collect(frame, source);
    });
    expect(source.reads).toBe(2);
    gpu.destroy();
  });

  it('requires consumers to close partial query iterators', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const source = new Source();
    await expect(
      draw(gpu, async (frame) => {
        const iterator = frame.query(source, rows)[Symbol.asyncIterator]();
        await iterator.next();
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.ended).toBe(1);
    gpu.destroy();
  });
});
