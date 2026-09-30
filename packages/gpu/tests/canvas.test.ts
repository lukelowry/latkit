import { expect, it, vi } from 'vitest';
import { createCanvasView, createGpu, createPresentation, type FrameInfo } from '../src/index.js';
import { deferred, fakeDevice } from './fixtures/device.js';
import { renderer } from './fixtures/render.js';

function canvasFixture(device: GPUDevice) {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const media = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const window = {
    devicePixelRatio: 2,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => media,
  };
  const observers: { disconnect: () => void; notify: () => void }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn();
      constructor(readonly callback: () => void) {
        observers.push({ disconnect: this.disconnect, notify: callback });
      }
      observe() {}
    },
  );
  vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'rgba8unorm' } });
  const texture = device.createTexture({
    size: [16, 16],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const context = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => texture };
  const attributes = new Map([
    ['width', '320'],
    ['height', '200'],
  ]);
  const canvas = {
    width: 320,
    height: 200,
    clientWidth: 100,
    clientHeight: 80,
    ownerDocument: { defaultView: window },
    getContext: () => context,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
      if (name === 'width') canvas.width = Number(value);
      else canvas.height = Number(value);
    },
    removeAttribute: (name: string) => attributes.delete(name),
  };
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    context,
    observers,
    frames,
    media,
    tick() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(1000);
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('coalesces canvas requests, keeps coordinates on redraw, and restores presentation ownership', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const received: FrameInfo[] = [],
    error = vi.fn();
  const view = createCanvasView({
    gpu,
    canvas: fixture.canvas,
    renderer: renderer((frame) => {
      received.push(frame);
    }),
    onError: error,
  });
  view.request({ at: 1 });
  view.request({ at: 2 });
  expect(fixture.frames.size).toBe(1);
  fixture.tick();
  await settle();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    at: 2,
    width: 200,
    height: 160,
    viewport: { width: 100, height: 80, pixelRatio: 2 },
  });
  view.request();
  fixture.tick();
  await settle();
  expect(received[1].at).toBe(2);
  view.pause();
  view.request({ at: 3 });
  expect(fixture.frames.size).toBe(0);
  view.resume();
  fixture.tick();
  await settle();
  expect(received[2].at).toBe(3);
  view.destroy();
  expect(fixture.context.unconfigure).toHaveBeenCalledTimes(1);
  expect(fixture.canvas.width).toBe(320);
  expect(fixture.canvas.height).toBe(200);
  expect(fixture.observers[0].disconnect).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  gpu.destroy();
});

it('reports device loss and stops scheduling without replacing native handles', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const lost = vi.fn();
  const view = createCanvasView({
    gpu,
    canvas: fixture.canvas,
    renderer: renderer(() => {}),
    onError: vi.fn(),
    onLost: lost,
  });
  fixture.tick();
  await settle();
  fake.lose('removed');
  await gpu.lost;
  await settle();
  view.request();
  expect(fixture.frames.size).toBe(0);
  expect(lost).toHaveBeenCalledWith(expect.objectContaining({ message: 'removed' }));
  view.destroy();
  gpu.destroy();
});

it('preserves the original configuration failure during cleanup', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  fixture.context.configure.mockImplementation(() => {
    throw new Error('configuration');
  });
  fixture.context.unconfigure.mockImplementation(() => {
    throw new Error('cleanup');
  });
  expect(() => createPresentation({ gpu, canvas: fixture.canvas })).toThrow('configuration');
  gpu.destroy();
});

it('keeps the presented backing size until asynchronous preparation completes', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const ready = deferred<void>();
  const error = vi.fn();
  const view = createCanvasView({
    gpu,
    canvas: fixture.canvas,
    renderer: renderer(async () => {
      await ready.promise;
    }),
    onError: error,
  });
  fixture.tick();
  await settle();
  expect(fixture.canvas.width).toBe(320);
  expect(fixture.canvas.height).toBe(200);
  ready.resolve();
  await settle();
  expect(fixture.canvas.width).toBe(200);
  expect(fixture.canvas.height).toBe(160);
  expect(error).not.toHaveBeenCalled();
  view.destroy();
  gpu.destroy();
});

it('releases presentation when DOM observation cannot be installed', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = disconnect;
      observe() {
        throw new Error('observation failed');
      }
    },
  );
  expect(() =>
    createCanvasView({
      gpu,
      canvas: fixture.canvas,
      renderer: renderer(() => {}),
      onError: vi.fn(),
    }),
  ).toThrow('observation failed');
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(fixture.context.unconfigure).toHaveBeenCalledTimes(1);
  expect(fixture.frames.size).toBe(0);
  gpu.destroy();
});
