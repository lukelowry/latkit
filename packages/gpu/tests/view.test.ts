import { expect, it, vi } from 'vitest';
import { createComposition, createGpu, type Gpu } from '../src/index.js';
import {
  BaseView,
  createPresentation,
  hold,
  rendererOf,
  type Encoding,
  type FrameInfo,
  type Preparation,
  type SetOptions,
  type ViewConfig,
  type ViewEvents,
} from '../src/kit.js';
import { deferred, fakeDevice } from './fixtures/device.js';
import { target } from './fixtures/render.js';

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
    tick() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(1000);
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface TestConfig extends ViewConfig {
  readonly items?: Readonly<Record<string, { readonly color?: string; readonly size?: number }>>;
  readonly limits?: { readonly bytes?: number; readonly rows?: number };
  readonly shade?: { readonly wgsl: string; readonly tick?: () => boolean };
  readonly camera?: { readonly x?: number; readonly y?: number };
  readonly input?:
    'navigate' | 'none' | { readonly mode?: 'navigate' | 'none'; readonly wheel?: string };
}
class TestView extends BaseView<TestConfig, ViewEvents, 'items', 'limits' | 'input' | 'camera'> {
  frames: FrameInfo[] = [];
  configured: { previous: TestConfig; next: TestConfig; options: SetOptions }[] = [];
  camera = { x: 0, y: 0 };
  attached = 0;
  detached = 0;
  released = false;
  animate = false;
  constructor(
    gpu: Gpu,
    config: TestConfig,
    private readonly wait: (frame: Preparation) => void | Promise<void> = () => {},
  ) {
    super(gpu, config, { records: ['items'], merged: ['limits', 'input'] });
    this.start();
  }
  refresh(): void {
    this.invalidate();
  }
  protected configure(previous: TestConfig, next: TestConfig, options: SetOptions): void {
    this.configured.push({ previous, next, options });
    this.invalidate();
  }
  protected moveCamera(camera: Record<string, unknown> | null): void {
    this.camera = camera ? { ...this.camera, ...camera } : { x: 0, y: 0 };
  }
  protected attach(): () => void {
    this.attached++;
    return () => this.detached++;
  }
  protected async prepare(frame: Preparation): Promise<void> {
    this.frames.push(frame);
    await this.wait(frame);
  }
  protected encode(frame: Encoding): void {
    void frame;
  }
  protected release(): void {
    this.released = true;
  }
  protected get animating(): boolean {
    return this.animate;
  }
}

it('presents on its canvas, coalescing frames, keeping at, pausing, and restoring the canvas', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const view = new TestView(gpu, { canvas: fixture.canvas, at: 1 });
  const error = vi.fn();
  view.on('error', error);
  view.set({ at: 2 });
  expect(fixture.frames.size).toBe(1);
  fixture.tick();
  await settle();
  expect(view.frames).toHaveLength(1);
  expect(view.frames[0]).toMatchObject({
    at: 2,
    width: 200,
    height: 160,
    viewport: { width: 100, height: 80, pixelRatio: 2 },
  });
  view.refresh();
  fixture.tick();
  await settle();
  expect(view.frames[1].at).toBe(2);
  view.set({ paused: true });
  view.set({ at: 3 });
  expect(fixture.frames.size).toBe(0);
  view.set({ paused: false });
  fixture.tick();
  await settle();
  expect(view.frames[2].at).toBe(3);
  expect(view.attached).toBe(1);
  view.destroy();
  expect(view.detached).toBe(1);
  expect(view.released).toBe(true);
  expect(fixture.context.unconfigure).toHaveBeenCalledTimes(1);
  expect(fixture.canvas.width).toBe(320);
  expect(fixture.canvas.height).toBe(200);
  expect(fixture.observers[0].disconnect).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  expect(() => view.set({ at: 4 })).toThrow('destroyed');
  gpu.destroy();
});

it('merges records per entry and options, removes with null, and replaces everything else', async () => {
  const gpu = await createGpu({ device: fakeDevice().device });
  const tick = () => true;
  const view = new TestView(gpu, {
    items: { a: { color: 'red', size: 2 }, b: { size: 1 } },
    limits: { bytes: 8, rows: 4 },
    shade: { wgsl: 'a', tick },
    input: 'navigate',
  });
  expect(view.config.input).toEqual({ mode: 'navigate' });
  view.set({
    items: { a: { size: 3 }, b: null, c: { color: 'blue', size: null } },
    limits: { rows: null },
    shade: { wgsl: 'b' },
    input: { wheel: 'modifier' },
    camera: { x: 5 },
  });
  expect(view.config).toEqual({
    items: { a: { color: 'red', size: 3 }, c: { color: 'blue' } },
    limits: { bytes: 8 },
    shade: { wgsl: 'b' },
    input: { mode: 'navigate', wheel: 'modifier' },
  });
  expect(view.camera).toEqual({ x: 5, y: 0 });
  view.set({ limits: null }, { animate: true });
  expect(view.config.limits).toBeUndefined();
  expect(view.configured.at(-1)?.options).toEqual({ animate: true });
  view.destroy();
  gpu.destroy();
});

it('reattaches input when the canvas or input changes, and attaches none for mode none', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const view = new TestView(gpu, {});
  expect(view.attached).toBe(0);
  view.set({ canvas: fixture.canvas });
  expect(view.attached).toBe(1);
  view.set({ input: { wheel: 'modifier' } });
  expect([view.attached, view.detached]).toEqual([2, 1]);
  view.set({ input: 'none' });
  expect([view.attached, view.detached]).toEqual([2, 2]);
  view.set({ canvas: null });
  expect(fixture.context.unconfigure).toHaveBeenCalledTimes(1);
  view.destroy();
  gpu.destroy();
});

it('reports device loss as an error and stops scheduling', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const view = new TestView(gpu, { canvas: fixture.canvas });
  const error = vi.fn();
  view.on('error', error);
  fixture.tick();
  await settle();
  fake.lose('removed');
  await gpu.lost;
  await settle();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: 'device-lost' }));
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
  const view = new TestView(gpu, { canvas: fixture.canvas }, () => ready.promise);
  fixture.tick();
  await settle();
  expect(fixture.canvas.width).toBe(320);
  expect(fixture.canvas.height).toBe(200);
  ready.resolve();
  await settle();
  expect(fixture.canvas.width).toBe(200);
  expect(fixture.canvas.height).toBe(160);
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
  expect(() => new TestView(gpu, { canvas: fixture.canvas })).toThrow('observation failed');
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(fixture.context.unconfigure).toHaveBeenCalledTimes(1);
  expect(fixture.frames.size).toBe(0);
  gpu.destroy();
});

it('lets a refresh finish, schedules animation, and holds the canvas while rendering elsewhere', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device),
    gate = deferred<void>();
  let signal!: AbortSignal;
  const view = new TestView(gpu, { canvas: fixture.canvas }, async (frame) => {
    signal = frame.signal;
    await gate.promise;
  });
  view.animate = true;
  fixture.tick();
  await settle();
  view.refresh();
  expect(signal.aborted).toBe(false);
  gate.resolve();
  await settle();
  expect(fixture.frames.size).toBe(1);
  const release = await hold(view);
  fixture.tick();
  await settle();
  const frames = view.frames.length;
  await gpu.render({
    views: [{ renderer: rendererOf(view), target: target(fake.device) }],
    timeMs: 0,
  });
  expect(view.frames).toHaveLength(frames + 1);
  expect(fixture.frames.size).toBe(0);
  release();
  expect(fixture.frames.size).toBe(1);
  view.destroy();
  expect(fixture.frames.size).toBe(0);
  gpu.destroy();
});

/** Enough render-pass surface for a composition to draw its panels. */
function compositing(fake: ReturnType<typeof fakeDevice>): void {
  const device = fake.native as unknown as Record<string, (...args: never[]) => unknown>;
  const pipeline = device.createRenderPipelineAsync,
    encoder = device.createCommandEncoder;
  device.createShaderModule = vi.fn(() => ({}));
  device.createRenderPipelineAsync = vi.fn(async (descriptor: never) => ({
    ...((await pipeline(descriptor)) as object),
    getBindGroupLayout: () => ({}),
  }));
  device.createCommandEncoder = vi.fn(() =>
    Object.assign(encoder() as object, {
      beginRenderPass: () => ({
        setPipeline() {},
        setViewport() {},
        setBindGroup() {},
        draw() {},
        end() {},
      }),
    }),
  );
}

it('composes views into one view, and keeps composed views off their own canvases', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  compositing(fake);
  const a = new TestView(gpu, {}),
    b = new TestView(gpu, {});
  const composition = createComposition(gpu, {
    views: [
      { view: a, region: [0, 0, 1, 0.5] },
      { view: b, region: [0, 0.5, 1, 0.5] },
    ],
  });
  expect(() => a.set({ canvas: fixture.canvas })).toThrow('composition');
  expect(() => createComposition(gpu, { views: [{ view: a, region: [0, 0, 2, 1] }] })).toThrow(
    'unit rectangle',
  );
  await gpu.render({
    views: [{ renderer: rendererOf(composition), target: target(fake.device) }],
    timeMs: 0,
  });
  expect(a.frames[0]).toMatchObject({ width: 16, height: 8 });
  expect(b.frames[0]).toMatchObject({ width: 16, height: 8 });
  composition.destroy();
  a.set({ canvas: fixture.canvas });
  a.destroy();
  b.destroy();
  gpu.destroy();
});

it('reports each drawn frame', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const view = new TestView(gpu, { canvas: fixture.canvas, at: 3 });
  const frames = vi.fn();
  view.on('frame', frames);
  fixture.tick();
  await settle();
  expect(frames).toHaveBeenCalledTimes(1);
  expect(frames.mock.lastCall?.[0]).toMatchObject({ at: 3, width: 200, height: 160 });
  view.destroy();
  gpu.destroy();
});

it('coalesces playhead and configuration changes without cancelling a captured canvas frame', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    fixture = canvasFixture(fake.device);
  const entered = deferred<void>(),
    gate = deferred<void>();
  let signal!: AbortSignal;
  const view = new TestView(
    gpu,
    { canvas: fixture.canvas, at: 0, limits: { rows: 1 } },
    async (frame) => {
      signal = frame.signal;
      if (frame.at === 0) {
        entered.resolve();
        await gate.promise;
      }
    },
  );
  const submitted: number[] = [];
  view.on('frame', (frame) => submitted.push(frame.at!));
  fixture.tick();
  await entered.promise;
  for (let at = 1; at <= 20; at++) view.set({ at, limits: { rows: at } });
  expect(view.config.at).toBe(20);
  expect(view.configured).toHaveLength(0);
  expect(signal.aborted).toBe(false);
  fixture.tick(); // A newer presentation tick arrives while the first preparation is active.
  gate.resolve();
  await settle();
  await settle();
  expect(submitted).toEqual([0, 20]);
  expect(view.configured).toHaveLength(1);
  expect(view.configured[0].next.limits?.rows).toBe(20);
  expect(fixture.frames.size).toBe(0);
  view.destroy();
  gpu.destroy();
});
it('captures composition children before an asynchronous sibling changes their desired state', async () => {
  const fake = fakeDevice();
  compositing(fake);
  const gpu = await createGpu({ device: fake.device });
  const right = new TestView(gpu, { limits: { rows: 1 } }, () => {
    expect(right.configured).toHaveLength(0);
  });
  const left = new TestView(gpu, {}, () => {
    right.set({ limits: { rows: 99 } });
  });
  const composition = createComposition(gpu, {
    views: [
      { view: left, region: [0, 0, 0.5, 1] },
      { view: right, region: [0.5, 0, 0.5, 1] },
    ],
  });
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: rendererOf(composition), target: target(fake.device) }],
  });
  expect(right.configured).toHaveLength(1);
  expect(right.config.limits?.rows).toBe(99);
  composition.destroy();
  left.destroy();
  right.destroy();
  gpu.destroy();
});
