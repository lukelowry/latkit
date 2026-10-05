import { expect, it, vi } from 'vitest';
import { createData, type Data, type Schema } from '@latkit/model';
import { createGpu, kit } from '../src/index.js';
import type { Preparation, Renderer } from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';
import { target } from './fixtures/render.js';

const index = { source: 'memo', type: 'node', version: 'rows' };
const schema: Schema = {
  axis: { name: 'time' },
  types: {
    node: {
      fields: { load: { type: 'float32' }, voltage: { type: 'float32', sampled: true } },
    },
  },
};
function data(): Data {
  const rows = { kind: 'range', offset: 0, count: 2 } as const;
  return createData(schema, [
    {
      kind: 'rows',
      index,
      rows,
      columns: {
        load: { kind: 'numeric', offset: 0, length: 2, values: Float32Array.of(1, 2) },
      },
    },
    ...[0, 1].map((frame) => ({
      kind: 'samples' as const,
      index,
      rows,
      firstFrame: frame,
      coordinates: Float64Array.of(frame),
      columns: {
        voltage: {
          kind: 'numeric' as const,
          offset: 0,
          length: 2,
          values: Float32Array.of(frame, frame + 1),
          rowStride: 1,
          frameStride: 2,
        },
      },
    })),
  ]);
}
/** A renderer whose frames run `prepare`, and a render of it at a coordinate. */
async function harness(prepare: (frame: Preparation) => Promise<void>) {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    surface = target(gpu.device);
  const renderer: Renderer = {
    capture: () => ({
      prepare: async (frame) => {
        await prepare(frame);
        return { encode() {}, submitted() {}, discard() {} };
      },
      release() {},
    }),
    destroy() {},
  };
  const render = async (at: number) => {
    await gpu.render({ views: [{ renderer, target: surface, at }], timeMs: 0 });
    await gpu.idle();
  };
  return { gpu, render };
}
/** Upload a field's pages, as a view does, and count the builds. */
function uploading(source: Data, field: string) {
  const build = vi.fn(async (frame: Preparation, _previous?: readonly kit.GpuPage[]) => {
    const pages: kit.GpuPage[] = [];
    for await (const block of frame.reader.fields({
      source,
      from: 'node',
      fields: { value: field },
    }))
      pages.push(...frame.upload(block, { select: ['value'] }));
    return pages;
  });
  return build;
}

it('reuses work until its deps or the coordinate of its sampled reads change', async () => {
  const source = data(),
    still = uploading(source, 'load'),
    playing = uploading(source, 'voltage');
  let deps: unknown[] = [source];
  const results: unknown[] = [];
  const { gpu, render } = await harness(async (frame) => {
    results.push(
      await frame.memo('still', deps, still),
      await frame.memo('playing', [source], playing),
    );
  });
  await render(0);
  const reads = gpu.stats().queries;
  await render(1);
  // Static reads hold at any coordinate, and reuse reads nothing.
  expect(still).toHaveBeenCalledTimes(1);
  expect(results[2]).toBe(results[0]);
  expect(playing).toHaveBeenCalledTimes(2);
  await render(1);
  expect(playing).toHaveBeenCalledTimes(2);
  expect(gpu.stats().queries).toBe(reads + 1);
  deps = [source, 'changed'];
  await render(1);
  expect(still).toHaveBeenCalledTimes(2);
  expect(still.mock.calls[1][1]).toBe(results[0]);
  gpu.destroy();
});

it('rebuilds after a bound buffer is written, memory it held is evicted, or its slot goes unused', async () => {
  const buffer = new kit.BufferData({ size: 16, label: 'memo test' });
  let use = true;
  const build = vi.fn((frame: Preparation) => frame.buffer(buffer));
  const { gpu, render } = await harness(async (frame) => {
    if (use) await frame.memo('bound', [], build);
  });
  await render(0);
  await render(0);
  expect(build).toHaveBeenCalledTimes(1);
  buffer.write({ data: Uint32Array.of(1, 2, 3, 4) });
  await render(0);
  expect(build).toHaveBeenCalledTimes(2);
  gpu.trim();
  await render(0);
  expect(build).toHaveBeenCalledTimes(3);
  use = false;
  await render(0);
  use = true;
  await render(0);
  expect(build).toHaveBeenCalledTimes(4);
  gpu.destroy();
});

it('refuses per-frame uniforms inside memoized work', async () => {
  const { gpu, render } = await harness(async (frame) => {
    await frame.memo('uniforms', [], (inner) => inner.uniforms(Float32Array.of(1, 2, 3, 4)));
  });
  await expect(render(0)).rejects.toMatchObject({ code: 'invalid-input' });
  gpu.destroy();
});
