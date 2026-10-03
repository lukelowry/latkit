import { failure, type Data } from '@latkit/model';
import { expect, it, vi } from 'vitest';
import {
  createGpu,
  type Gpu,
  type ItemEvents,
  type ItemViewConfig,
  type Point,
  type Viewport,
} from '../src/index.js';
import { BaseItemView, rendererOf, type Encoding, type Preparation } from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';
import { target } from './fixtures/render.js';

interface Plane {
  readonly center: readonly [number, number];
  readonly scale: number;
  readonly fit: boolean;
}
interface Dot {
  readonly id: string;
}
interface DotHit extends Dot {
  readonly distance: number;
}
interface DotConfig extends ItemViewConfig {
  readonly dots: Readonly<Record<string, readonly [number, number]>>;
  readonly marks?: Readonly<
    Record<string, { readonly color?: string | { readonly field: string } }>
  >;
  readonly camera?: Partial<Plane>;
}
const source = { schema: { tables: {} }, tables: {} } as unknown as Data;
const viewport: Viewport = { width: 100, height: 100, pixelRatio: 1 };

class Dots extends BaseItemView<
  DotConfig,
  ItemEvents<Dot, DotHit, Plane>,
  Dot,
  DotHit,
  Plane,
  'marks'
> {
  drawn?: Plane;
  searches = 0;
  /** Search for hover asynchronously, as views whose hits read data do. */
  async = false;
  constructor(gpu: Gpu, config: DotConfig) {
    super(gpu, config, {
      records: ['marks'],
      fields: ['color'],
      framed: ['center', 'scale'],
      style: { animationMs: 100, hover: 'on' },
    });
    this.start();
  }
  get style() {
    return this.viewStyle;
  }
  move(point: Point | null): void {
    this.pointer(point);
  }
  click(ids: readonly string[]): void {
    this.choose(ids.map((id) => ({ id })));
  }
  protected defaultCamera(): Plane {
    return { center: [0, 0], scale: 1, fit: true };
  }
  protected resolveCamera(camera: Plane): Plane {
    if (!(camera.scale > 0)) throw failure('invalid-input', 'Invalid scale');
    return camera;
  }
  protected framing(items: readonly Dot[] | undefined): Partial<Plane> | undefined {
    const points = (items?.map((item) => item.id) ?? Object.keys(this.config.dots)).map(
      (id) => this.config.dots[id],
    );
    if (!points.length) return undefined;
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
    return {
      center: [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2],
      scale: 50 / span,
    };
  }
  protected interpolate(from: Plane, to: Plane, t: number): Plane {
    const mix = (a: number, b: number) => a + (b - a) * t;
    return {
      ...to,
      center: [mix(from.center[0], to.center[0]), mix(from.center[1], to.center[1])],
      scale: mix(from.scale, to.scale),
    };
  }
  protected panned(camera: Plane, dx: number, dy: number): Plane {
    return {
      ...camera,
      center: [camera.center[0] - dx / camera.scale, camera.center[1] - dy / camera.scale],
    };
  }
  protected zoomed(camera: Plane, factor: number): Plane {
    return { ...camera, scale: camera.scale * factor };
  }
  protected position(item: Dot): Point | null {
    const p = this.config.dots[item.id],
      camera = this.drawn;
    if (!p || !camera) return null;
    return [
      (p[0] - camera.center[0]) * camera.scale + viewport.width / 2,
      (p[1] - camera.center[1]) * camera.scale + viewport.height / 2,
    ];
  }
  protected identify(item: Dot): string {
    return item.id;
  }
  protected accept(item: Dot): void {
    if (!(item.id in this.config.dots)) throw failure('invalid-input', 'Unknown dot');
  }
  protected contains(item: Dot): boolean {
    return item.id in this.config.dots;
  }
  protected hits(point: Point, radiusPx: number): readonly DotHit[] {
    return Object.keys(this.config.dots)
      .flatMap((id) => {
        const p = this.position({ id });
        return p ? [{ id, distance: Math.hypot(p[0] - point[0], p[1] - point[1]) }] : [];
      })
      .filter((hit) => hit.distance <= radiusPx)
      .sort((a, b) => a.distance - b.distance);
  }
  protected async compileShade(): Promise<void> {}
  protected check(config: DotConfig): void {
    super.check(config);
    if ('bad' in config.dots) throw failure('invalid-input', 'Bad dot');
  }
  protected configure(): void {
    this.invalidate();
  }
  protected async prepare(frame: Preparation): Promise<void> {
    this.drawn = await this.frameCamera(frame);
    this.hoverFrame(frame, (point, radius) => {
      this.searches++;
      const hit = this.hits(point, radius)[0] ?? null;
      return this.async ? Promise.resolve(hit) : hit;
    });
  }
  protected encode(frame: Encoding): void {
    void frame;
  }
  protected release(): void {}
}

async function setup(config: Partial<DotConfig> = {}) {
  const gpu = await createGpu({ device: fakeDevice().device });
  const view = new Dots(gpu, { source, dots: { a: [0, 0], b: [10, 0] }, ...config });
  const events: [string, unknown][] = [];
  for (const name of ['frame', 'camera', 'hover', 'select', 'error'] as const)
    view.on(name, (value: unknown) => events.push([name, value]));
  const frame = async (timeMs = 0) => {
    await gpu.render({
      timeMs,
      views: [{ renderer: rendererOf(view), target: target(gpu.device), viewport }],
    });
    await Promise.resolve();
  };
  return { gpu, view, events, frame };
}

it('reports frame, camera, hover, and select on one microtask, in that order', async () => {
  const { view, events, frame } = await setup();
  view.move([50, 50]);
  view.set({ dots: { a: [0, 0] } });
  view.select([{ id: 'a' }]);
  await frame();
  expect(events.map(([name]) => name)).toEqual(['frame', 'camera', 'hover']);
  expect(events[1][1]).toEqual({ center: [0, 0], scale: 50, fit: true });
  expect(events[2][1]).toEqual({ id: 'a', distance: 0 });
  events.length = 0;
  view.set({ source: { ...source }, dots: { b: [0, 0] } });
  await frame();
  expect(events.map(([name]) => name)).toEqual(['frame', 'hover', 'select']);
  expect(view.selection).toEqual([]);
});

it('selects silently and uniquely, and reports only user changes', async () => {
  const { view, events, frame } = await setup();
  view.select([{ id: 'a' }, { id: 'a' }, { id: 'b' }]);
  expect(view.selection.map((item) => item.id)).toEqual(['a', 'b']);
  expect(Object.isFrozen(view.selection)).toBe(true);
  expect(() => view.select([{ id: 'z' }])).toThrow('Unknown dot');
  await frame();
  expect(events.some(([name]) => name === 'select')).toBe(false);
  view.click(['a', 'b']);
  view.click(['b']);
  await Promise.resolve();
  expect(events.filter(([name]) => name === 'select').map(([, value]) => value)).toEqual([
    [{ id: 'b' }],
  ]);
});

it('picks nearest first within a radius and limit, and rejects bad points', async () => {
  const { view, frame } = await setup({ dots: { a: [0, 0], b: [1, 0], c: [4, 0] } });
  await frame();
  const hits = await view.pick([25, 50], { radiusPx: 20 });
  expect(hits.map((hit) => hit.id)).toEqual(['a', 'b']);
  expect((await view.pick([25, 50], { radiusPx: 20, limit: 1 })).map((hit) => hit.id)).toEqual([
    'a',
  ]);
  await expect(view.pick([Number.NaN, 0])).rejects.toMatchObject({ code: 'invalid-input' });
  await expect(view.pick([0, 0], { limit: 0 })).rejects.toMatchObject({ code: 'invalid-input' });
  expect(view.locate({ id: 'a' })).toEqual([25, 50]);
});

it('follows the data while fit holds, and stops when a framed key moves', async () => {
  const { view, frame } = await setup();
  await frame();
  expect(view.camera).toEqual({ center: [5, 0], scale: 5, fit: true });
  view.set({ dots: { a: [0, 0], b: [20, 0] } });
  await frame();
  expect(view.camera).toEqual({ center: [10, 0], scale: 2.5, fit: true });
  view.set({ camera: { scale: 1 } });
  expect(view.camera.fit).toBe(false);
  view.set({ dots: { a: [0, 0] } });
  await frame();
  expect(view.camera).toEqual({ center: [10, 0], scale: 1, fit: false });
  view.set({ camera: null });
  await frame();
  expect(view.camera).toEqual({ center: [0, 0], scale: 50, fit: true });
  expect(() => view.set({ camera: { scale: -1 } })).toThrow('Invalid scale');
});

it('frames items once, and eases moves that ask to animate', async () => {
  const { view, frame } = await setup({ camera: { center: [0, 0], scale: 1 } });
  await frame(0);
  expect(view.camera.fit).toBe(false);
  view.fit([{ id: 'b' }]);
  await frame(0);
  expect(view.camera).toEqual({ center: [10, 0], scale: 50, fit: false });
  view.set({ camera: { scale: 25 } }, { animate: true });
  await frame(1000);
  expect(view.drawn!.scale).toBe(50);
  await frame(1050);
  expect(view.drawn!.scale).toBe(37.5);
  await frame(1100);
  expect(view.drawn!.scale).toBe(25);
});

it('reports hover once per change and clears it on leave', async () => {
  const { view, events, frame } = await setup();
  await frame();
  expect(view.searches).toBe(0);
  view.move([25, 50]);
  await frame();
  await frame();
  expect(view.stats().hover).toBe('active');
  view.move(null);
  await Promise.resolve();
  expect(events.filter(([name]) => name === 'hover').map(([, value]) => value)).toEqual([
    { id: 'a', distance: 0 },
    null,
  ]);
  view.set({ hover: 'off' });
  expect(view.stats().hover).toBe('off');
});

it('expands field shorthands once, keeping identity across unrelated patches', async () => {
  const { view } = await setup({ marks: { a: { color: 'load' } } });
  const mark = view.config.marks!.a;
  expect(mark.color).toEqual({ field: 'load' });
  view.set({ hover: 'auto' });
  expect(view.config.marks!.a).toBe(mark);
});

it('draws exported frames at their own size without changing the view', async () => {
  const { gpu, view, events, frame } = await setup();
  await frame();
  const camera = view.camera;
  view.select([{ id: 'a' }]);
  view.fit([{ id: 'b' }]);
  events.length = 0;
  await gpu.render({
    timeMs: 0,
    views: [
      {
        renderer: rendererOf(view),
        target: target(gpu.device),
        viewport: { width: 200, height: 100, pixelRatio: 1 },
        presented: false,
      },
    ],
  });
  await Promise.resolve();
  // The export frames what the view is going to show, and the view still waits to show it.
  expect(view.drawn).toEqual({ center: [10, 0], scale: 50, fit: false });
  expect(view.camera).toBe(camera);
  expect(view.selection).toEqual([{ id: 'a' }]);
  expect(events.map(([name]) => name)).toEqual(['frame']);
  await frame();
  expect(view.camera).toEqual({ center: [10, 0], scale: 50, fit: false });
});

it('rejects unknown camera and input options, and modes the view does not have', async () => {
  const { gpu, view } = await setup();
  expect(() => view.set({ camera: { zoom: 2 } as Partial<Plane> })).toThrow(
    'Unknown camera option',
  );
  expect(() => view.set({ input: 'edit' })).toThrow('Unsupported input mode');
  expect(() => view.set({ input: { mode: 'inspect', drag: true } as never })).toThrow(
    'Unknown input option',
  );
  expect(view.config.input).toBeUndefined();
  expect(() => new Dots(gpu, { source, dots: {}, camera: { zoom: 2 } as Partial<Plane> })).toThrow(
    'Unknown camera option',
  );
  expect(() => new Dots(gpu, { source, dots: {}, input: { wheel: 'always' } as never })).toThrow(
    'Invalid wheel',
  );
  expect(() => new Dots(gpu, { source, dots: {}, camera: { scale: 0 } })).toThrow('Invalid scale');
});

it('applies the style of a deferred patch, never that of a later rejected one', async () => {
  const { view } = await setup();
  const captured = rendererOf(view).capture();
  view.set({ hoverWidthPx: 5 });
  expect(() => view.set({ hoverWidthPx: 9, dots: { bad: [0, 0] } })).toThrow('Bad dot');
  captured.release();
  expect(view.style.hoverWidthPx).toBe(5);
});

/** A canvas that dispatches pointer events, with just enough DOM for a view to present on it. */
function pointerCanvas(device: GPUDevice) {
  vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'rgba8unorm' } });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const texture = device.createTexture({
    size: [100, 100],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const window = Object.assign(new EventTarget(), {
    devicePixelRatio: 1,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    matchMedia: () => media,
  });
  const canvas = Object.assign(new EventTarget(), {
    width: 100,
    height: 100,
    clientWidth: 100,
    clientHeight: 100,
    offsetWidth: 100,
    offsetHeight: 100,
    clientLeft: 0,
    clientTop: 0,
    tabIndex: -1,
    style: {},
    ownerDocument: { defaultView: window },
    getContext: () => ({ configure() {}, unconfigure() {}, getCurrentTexture: () => texture }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    getAttribute: () => null,
    setAttribute() {},
    removeAttribute() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
    focus() {},
  });
  const send = (type: string, x: number, button = 2) =>
    canvas.dispatchEvent(
      Object.assign(new Event(type, { cancelable: true }), {
        button,
        pointerId: 1,
        clientX: x,
        clientY: 50,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    );
  return { canvas: canvas as unknown as HTMLCanvasElement, send };
}

it('opens the menu for a right click in place, never for a right drag, wherever it asks', async () => {
  const gpu = await createGpu({ device: fakeDevice().device });
  const { canvas, send } = pointerCanvas(gpu.device);
  const view = new Dots(gpu, { source, dots: { a: [0, 0] }, canvas });
  const menus: unknown[] = [];
  view.on('contextmenu', (menu) => menus.push(menu));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Asked on press, as on macOS and Linux: the release decides.
  send('pointerdown', 10);
  send('contextmenu', 10);
  send('pointermove', 40);
  send('pointerup', 40);
  // Asked after release, as on Windows.
  send('pointerdown', 10);
  send('pointermove', 40);
  send('pointerup', 40);
  send('contextmenu', 40);
  await settle();
  expect(menus).toHaveLength(0);
  send('pointerdown', 10);
  send('contextmenu', 10);
  send('pointerup', 11);
  send('pointerdown', 10);
  send('pointerup', 11);
  send('contextmenu', 11);
  await settle();
  expect(menus).toMatchObject([
    { point: [11, 50], trigger: 'pointer' },
    { point: [11, 50], trigger: 'pointer' },
  ]);
  view.destroy();
  vi.unstubAllGlobals();
  gpu.destroy();
});

it('publishes an asynchronous hover once and reuses it while nothing moves', async () => {
  const { view, events, frame } = await setup();
  view.async = true;
  await frame();
  view.move([25, 50]);
  await frame();
  await frame();
  await frame();
  expect(view.searches).toBe(1);
  expect(events.filter(([name]) => name === 'hover').map(([, value]) => value)).toEqual([
    { id: 'a', distance: 0 },
  ]);
  view.move([75, 50]);
  await frame();
  await frame();
  expect(view.searches).toBe(2);
  expect(events.filter(([name]) => name === 'hover').at(-1)?.[1]).toEqual({ id: 'b', distance: 0 });
});
