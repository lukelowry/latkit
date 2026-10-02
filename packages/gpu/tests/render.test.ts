import { describe, expect, it, vi } from 'vitest';
import { createGpu } from '../src/index.js';
import { BufferData, createRenderTarget } from '../src/kit.js';
import { deferred, fakeDevice, record, type FakeTexture } from './fixtures/device.js';
import { draw, renderer, target } from './fixtures/render.js';

describe('frame ownership', () => {
  it('prepares all views before encoding and submits composition once', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const order: string[] = [];
    const make = (id: string) =>
      renderer(
        () => {
          order.push('prepare ' + id);
        },
        (frame) => {
          order.push('encode ' + id);
          record(frame.encoder, () => order.push('draw ' + id));
        },
      );
    await gpu.render({
      timeMs: 123,
      views: [
        { renderer: make('a'), target: target(fake.device), at: 99 },
        { renderer: make('b'), target: target(fake.device), at: 0.5 },
      ],
      encode: (encoder) => record(encoder, () => order.push('compose')),
    });
    expect(order).toEqual([
      'prepare a',
      'prepare b',
      'encode a',
      'encode b',
      'draw a',
      'draw b',
      'compose',
    ]);
    expect(fake.queue.submit).toHaveBeenCalledTimes(1);
    gpu.destroy();
  });

  it('never submits a partially failed frame', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    await expect(
      gpu.render({
        timeMs: 0,
        views: [
          {
            renderer: renderer((frame) => {
              frame.uniforms(new Uint32Array(4));
            }),
            target: target(fake.device),
          },
          {
            renderer: renderer(() => {
              throw new Error('preparation failed');
            }),
            target: target(fake.device),
          },
        ],
      }),
    ).rejects.toThrow('preparation failed');
    expect(fake.queue.submit).not.toHaveBeenCalled();
    expect(gpu.stats().gpuBytes).toBe(0);
    gpu.destroy();
  });

  it('rejects reentrant preparation of the same view', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const gate = deferred<void>();
    const view = renderer(() => gate.promise),
      output = target(fake.device);
    const request = { timeMs: 0, views: [{ renderer: view, target: output }] };
    const pending = gpu.render(request);
    await expect(gpu.render(request)).rejects.toMatchObject({ code: 'busy' });
    gate.resolve();
    await pending;
    gpu.destroy();
  });

  it('keeps cancelled, uncooperative renderers busy until preparation actually settles', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const gate = deferred<void>(),
      abort = new AbortController();
    const view = renderer(() => gate.promise),
      output = target(fake.device);
    const pending = gpu.render({
      timeMs: 0,
      signal: abort.signal,
      views: [{ renderer: view, target: output }],
    });
    const failure = expect(pending).rejects.toBe('stop');
    await Promise.resolve();
    abort.abort('stop');
    await failure;
    await expect(
      gpu.render({ timeMs: 0, views: [{ renderer: view, target: output }] }),
    ).rejects.toMatchObject({ code: 'busy' });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await gpu.render({ timeMs: 0, views: [{ renderer: view, target: output }] });
    gpu.destroy();
  });

  it('protects textures after their owner releases them until submitted work completes', async () => {
    const fake = fakeDevice({ deferCompletion: true }),
      gpu = await createGpu({ device: fake.device });
    const output = createRenderTarget({ gpu, width: 16, height: 16 });
    const texture = output.texture() as FakeTexture;
    await gpu.render({ timeMs: 0, views: [{ renderer: renderer(() => {}), target: output }] });
    output.destroy();
    expect(texture.destroyed).toBe(false);
    expect(gpu.stats().gpuBytes).toBe(1024);
    fake.finish();
    await gpu.idle();
    expect(texture.destroyed).toBe(true);
    expect(gpu.stats().gpuBytes).toBe(0);
    gpu.destroy();
  });

  it('bounds submissions even when independent preparations finish together', async () => {
    const fake = fakeDevice({ deferCompletion: true }),
      gpu = await createGpu({ device: fake.device, maxFramesInFlight: 1 });
    const gate = deferred<void>();
    const first = gpu.render({
      timeMs: 0,
      views: [{ renderer: renderer(() => gate.promise), target: target(fake.device) }],
    });
    const second = gpu.render({
      timeMs: 0,
      views: [{ renderer: renderer(() => gate.promise), target: target(fake.device) }],
    });
    gate.resolve();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.queue.submit).toHaveBeenCalledTimes(1);
    fake.finish();
    await second;
    expect(fake.queue.submit).toHaveBeenCalledTimes(2);
    fake.finish();
    await gpu.idle();
    gpu.destroy();
  });

  it('rejects buffers edited after preparation and before encoding', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const data = new BufferData({ size: 4 });
    await expect(
      draw(gpu, (frame) => {
        frame.buffer(data);
        data.write({ data: Float32Array.of(2) });
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(fake.queue.submit).not.toHaveBeenCalled();
    gpu.destroy();
  });

  it('deduplicates pipeline builds and retries failures', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const descriptor = {
      layout: 'auto',
      vertex: { module: {} as GPUShaderModule, entryPoint: 'vs' },
    } as const;
    const [a, b] = await Promise.all([
      gpu.renderPipeline(descriptor),
      gpu.renderPipeline(descriptor),
    ]);
    expect(a).toBe(b);
    expect(fake.native.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
    const broken = { ...descriptor };
    fake.native.createRenderPipelineAsync.mockRejectedValueOnce(new Error('shader failed'));
    await expect(gpu.renderPipeline(broken)).rejects.toThrow('shader failed');
    await gpu.renderPipeline(broken);
    expect(fake.native.createRenderPipelineAsync).toHaveBeenCalledTimes(3);
    gpu.destroy();
  });

  it('isolates device generations and never destroys a borrowed device', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    await draw(gpu, (frame) => {
      frame.buffer(new BufferData({ size: 1024 }));
    });
    fake.lose();
    await gpu.lost;
    await expect(draw(gpu, () => {})).rejects.toMatchObject({ code: 'device-lost' });
    expect(fake.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    gpu.destroy();
    expect(fake.native.destroy).not.toHaveBeenCalled();
  });

  it('owns a requested device and validates required features on borrowed devices', async () => {
    const fake = fakeDevice();
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: async () => ({ requestDevice: async () => fake.device }) },
    });
    const gpu = await createGpu();
    gpu.destroy();
    expect(fake.native.destroy).toHaveBeenCalledTimes(1);
    await expect(
      createGpu({ device: fake.device, requiredFeatures: ['shader-f16'] }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});
