import { afterAll, bench, describe } from 'vitest';
import { createGpu } from '../src/index.js';
import { fakeDevice } from './fixtures/device.js';
import { Source } from './fixtures/source.js';
import { renderer, target } from './fixtures/render.js';

/** Fake-device timings isolate JavaScript plumbing. Run test:browser for actual GPU execution. */
for (const count of [100_000, 1_000_000, 4_000_000]) {
  describe(count.toLocaleString('en-US') + ' native rows', async () => {
    const fake = fakeDevice();
    const gpu = await createGpu({
      device: fake.device,
      budget: { cpuBytes: 64 * 1024 ** 2, gpuBytes: 64 * 1024 ** 2 },
      pageBytes: 64 * 1024,
    });
    const source = new Source(count, { blockRows: 16384 });
    const view = renderer(async (frame) => {
      for await (const block of frame.reader.fields({
        source: source.data,
        from: 'node',
        fields: { value: 'value' },
      }))
        frame.upload(block, { select: ['value'] });
    });
    const request = { timeMs: 0, views: [{ renderer: view, target: target(fake.device) }] };
    bench(
      'cold native query + upload',
      async () => {
        gpu.trim();
        await gpu.render(request);
        await gpu.idle();
        fake.queue.writeBuffer.mockClear();
        fake.queue.submit.mockClear();
        fake.buffers.length = 0;
      },
      { iterations: 3, time: 0, warmupIterations: 1, warmupTime: 0 },
    );
    bench(
      'resident redraw',
      async () => {
        await gpu.render(request);
        await gpu.idle();
        fake.queue.submit.mockClear();
      },
      { iterations: 10, time: 0, warmupIterations: 1, warmupTime: 0 },
    );
    afterAll(() => gpu.destroy());
  });
}
