/**
 * A controller under test: the real CPU collaborators (scene, focus, camera, interactor, text)
 * behind fake device-bound ones. A fake pool mints fake devices, the renderer records what each
 * frame would draw, the frame loop never schedules (tests pump frames by hand), and the gesture
 * and keyboard adapters hand tests their `emit`, so a test drives the diagram as a user would.
 */

import type { DeviceLease, DevicePool, Frame, FrameLoop, Presentation } from '@latkit/gpu';
import { vi } from 'vitest';

import type { Viewport } from '../../src/camera.js';
import {
  createDiagramWithDeps,
  type ControllerDeps,
  type Diagram,
  type Events,
  type Options,
} from '../../src/controller.js';
import type { Gesture, GesturePolicy } from '../../src/input/gestures.js';
import type { KeyIntent } from '../../src/input/keyboard.js';
import type { Surface } from '../../src/input/surface.js';
import type { Part } from '../../src/part.js';
import type { DrawCounts, Mirrors } from '../../src/webgpu/buffers.js';
import type { AtlasPixels, Renderer } from '../../src/webgpu/renderer.js';
import { fakeRasterizer } from './text-rasterizer.js';

/** The canvas's CSS size and its client offset. */
export const WIDTH = 800;
export const HEIGHT = 600;
export const LEFT = 10;
export const TOP = 20;

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks run: frame notices, promise callbacks. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** A renderer that draws nothing and records every frame's draw counts. */
export class FakeRenderer {
  onPipelinesReady?: () => void;
  onPipelineError?: (cause: unknown) => void;
  /** Whether pipelines are ready; `render` submits only then. */
  ready = true;
  /** Draw counts of every submitted frame. */
  readonly frames: DrawCounts[] = [];
  /** The shade WGSL it draws with. */
  shade: string | null;
  /** Set to reject the next `setShade`, as WGSL that does not compile would. */
  nextShadeError: Error | null = null;
  /** Set to hold the next `setShade` until settled by hand. */
  nextShadeGate: Deferred<void> | null = null;

  constructor(
    readonly presentation: Presentation<HTMLCanvasElement>,
    readonly mirrors: Mirrors,
    shade: string | null,
  ) {
    this.shade = shade;
  }

  render = vi.fn((counts: DrawCounts, atlas: AtlasPixels): boolean => {
    if (!this.ready) return false;
    this.frames.push({ ...counts });
    atlas.clean();
    return true;
  });

  writeColormap = vi.fn((_lut: Uint8Array) => {});

  setShade = vi.fn((wgsl: string | null): Promise<void> => {
    const error = this.nextShadeError;
    this.nextShadeError = null;
    if (error !== null) return Promise.reject(error);
    const gate = this.nextShadeGate;
    this.nextShadeGate = null;
    if (gate) {
      return gate.promise.then(() => {
        this.shade = wgsl;
      });
    }
    this.shade = wgsl;
    return Promise.resolve();
  });

  destroy = vi.fn();

  /** The last frame's draw counts. */
  get last(): DrawCounts | undefined {
    return this.frames[this.frames.length - 1];
  }
}

/** A frame loop that never schedules: tests pump frames through the controller's callback. */
export class FakeFrameLoop {
  paused = false;
  destroyed = false;

  constructor(
    readonly presentation: Presentation<HTMLCanvasElement>,
    readonly render: (frame: Frame) => boolean,
  ) {}

  wake = vi.fn();
  frameNow = vi.fn();
  pause = vi.fn(() => {
    this.paused = true;
  });
  resume = vi.fn(() => {
    this.paused = false;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
  });

  /** Run one frame through the controller's callback; returns whether it wants another. */
  frame(init: Partial<Frame> = {}): boolean {
    return this.render({
      now: performance.now(),
      width: WIDTH,
      height: HEIGHT,
      backingScale: 1,
      settled: true,
      ...init,
    });
  }
}

/** A gesture adapter whose `emit` a test calls, tracking drags so `cancel` ends one. */
export interface FakeGestures {
  readonly policy: GesturePolicy;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  emit(gesture: Gesture): void;
}

/** A keyboard adapter whose `emit` a test calls, releasing a held Space on destroy. */
export interface FakeKeyboard {
  readonly destroy: ReturnType<typeof vi.fn>;
  emit(intent: KeyIntent): boolean;
}

export interface FakeSurface extends Surface {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly setNavigable: ReturnType<typeof vi.fn>;
  viewport: Viewport;
}

function makeSurface(element: HTMLCanvasElement): FakeSurface {
  return {
    element,
    viewport: { w: WIDTH, h: HEIGHT },
    size() {
      return { w: this.viewport.w, h: this.viewport.h };
    },
    rect() {
      return new DOMRect(LEFT, TOP, this.viewport.w, this.viewport.h);
    },
    setNavigable: vi.fn(),
    destroy: vi.fn(),
  };
}

function makePresentation(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
): Presentation<HTMLCanvasElement> {
  return {
    canvas,
    device,
    context: { canvas } as unknown as GPUCanvasContext,
    format: 'bgra8unorm',
    resize: vi.fn(() => false),
    observe: vi.fn(() => () => {}),
    destroy: vi.fn(),
  };
}

/** One fake device with its loss signal. */
export interface FakeDevice {
  readonly device: GPUDevice;
  readonly lost: Deferred<GPUDeviceLostInfo>;
}

export function fakeDevice(limits: Partial<GPUSupportedLimits> = {}): FakeDevice {
  const lost = deferred<GPUDeviceLostInfo>();
  return { device: { limits, lost: lost.promise } as unknown as GPUDevice, lost };
}

/** A pool that mints one fake device per acquisition and counts every lease release. */
export interface FakePool extends DevicePool {
  readonly devices: FakeDevice[];
  readonly releases: ReturnType<typeof vi.fn>;
  /** Limits the next devices report. */
  limits: Partial<GPUSupportedLimits>;
  /** Hold the next acquisition until released; returns its release. */
  hold(): () => void;
  /** Reject the next acquisition with `error`. */
  fail(error: unknown): void;
}

export function fakePool(): FakePool {
  const devices: FakeDevice[] = [];
  const releases = vi.fn();
  let gate: Deferred<void> | null = null;
  let failure: { readonly error: unknown } | null = null;
  const pool: FakePool = {
    devices,
    releases,
    limits: {},
    hold() {
      const held = deferred<void>();
      gate = held;
      return () => held.resolve();
    },
    fail(error) {
      failure = { error };
    },
    async acquire(): Promise<DeviceLease> {
      if (gate) {
        const pending = gate;
        gate = null;
        await pending.promise;
      }
      if (failure) {
        const { error } = failure;
        failure = null;
        throw error;
      }
      const entry = fakeDevice(pool.limits);
      devices.push(entry);
      let released = false;
      return {
        device: entry.device,
        release: () => {
          if (released) return;
          released = true;
          releases(entry.device);
        },
      };
    },
  };
  return pool;
}

/** Every fake a controller is built from, and the seam that hands them out. */
export interface Fakes {
  readonly deps: ControllerDeps;
  readonly pool: FakePool;
  readonly canvas: HTMLCanvasElement;
  readonly surface: FakeSurface;
  readonly rasterizer: ReturnType<typeof fakeRasterizer>;
  readonly renderers: FakeRenderer[];
  readonly loops: FakeFrameLoop[];
  readonly gestures: FakeGestures[];
  readonly keyboards: FakeKeyboard[];
  readonly presentations: Presentation<HTMLCanvasElement>[];
  /** A controller over these fakes, leasing from the fake pool. */
  create(options?: Options): Diagram;
}

/** Build the fakes and the `ControllerDeps` seam over them. */
export function createFakes(): Fakes {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const surface = makeSurface(canvas);
  const pool = fakePool();
  const rasterizer = fakeRasterizer();
  const renderers: FakeRenderer[] = [];
  const loops: FakeFrameLoop[] = [];
  const gestures: FakeGestures[] = [];
  const keyboards: FakeKeyboard[] = [];
  const presentations: Presentation<HTMLCanvasElement>[] = [];

  const deps: ControllerDeps = {
    createSurface: vi.fn(() => surface),
    createPresentation: vi.fn((device: GPUDevice, target: HTMLCanvasElement) => {
      const presentation = makePresentation(device, target);
      presentations.push(presentation);
      return presentation;
    }),
    Renderer: vi.fn(
      (presentation: Presentation<HTMLCanvasElement>, mirrors: Mirrors, shade: string | null) => {
        const renderer = new FakeRenderer(presentation, mirrors, shade);
        renderers.push(renderer);
        return renderer as unknown as Renderer;
      },
    ) as unknown as typeof Renderer,
    createFrameLoop: vi.fn(
      (presentation: Presentation<HTMLCanvasElement>, render: (frame: Frame) => boolean) => {
        const loop = new FakeFrameLoop(presentation, render);
        loops.push(loop);
        return loop as unknown as FrameLoop;
      },
    ),
    attachGestures: vi.fn(
      (_surface: Surface, emit: (gesture: Gesture) => void, policy: GesturePolicy) => {
        let drag: { sx: number; sy: number } | null = null;
        const adapter: FakeGestures = {
          policy,
          emit(gesture) {
            if (gesture.kind === 'dragStart') drag = { sx: gesture.sx, sy: gesture.sy };
            else if (gesture.kind === 'dragMove' && drag) drag = { sx: gesture.sx, sy: gesture.sy };
            else if (gesture.kind === 'dragEnd') drag = null;
            emit(gesture);
          },
          // As the real adapter: a drag in flight ends cancelled at its last point.
          cancel: vi.fn(() => {
            const last = drag;
            if (!last) return;
            drag = null;
            emit({
              kind: 'dragEnd',
              sx: last.sx,
              sy: last.sy,
              clientX: last.sx + LEFT,
              clientY: last.sy + TOP,
              cancelled: true,
            });
          }),
          destroy: vi.fn(),
        };
        gestures.push(adapter);
        return adapter;
      },
    ),
    attachKeyboard: vi.fn((_canvas: HTMLCanvasElement, emit: (intent: KeyIntent) => boolean) => {
      /** Space is held and the controller claimed its press. */
      let spaceHeld = false;
      const adapter: FakeKeyboard = {
        emit(intent) {
          const used = emit(intent);
          if (intent.kind === 'space') spaceHeld = intent.down && used;
          return used;
        },
        // As the real adapter: a Space still held is released on the way out.
        destroy: vi.fn(() => {
          if (!spaceHeld) return;
          spaceHeld = false;
          emit({ kind: 'space', down: false });
        }),
      };
      keyboards.push(adapter);
      return adapter;
    }),
    createRasterizer: vi.fn(() => rasterizer),
  };

  return {
    deps,
    pool,
    canvas,
    surface,
    rasterizer,
    renderers,
    loops,
    gestures,
    keyboards,
    presentations,
    create: (options = {}) => createDiagramWithDeps({ devices: pool, ...options }, deps),
  };
}

/** One event as the host heard it. */
export interface Heard {
  readonly event: keyof Events;
  readonly payload: unknown;
}

/** Every event name, so a harness can listen to all of them. */
const EVENT_NAMES = [
  'hover',
  'select',
  'contextmenu',
  'open',
  'connect',
  'move',
  'delete',
  'fit',
  'attached',
  'painted',
  'deviceLost',
  'pipelineError',
] as const satisfies readonly (keyof Events)[];

/** Options for a press-and-drag. */
export interface DragOptions {
  readonly button?: number;
  readonly pointerType?: string;
  readonly shift?: boolean;
  /** Leave the drag in flight: no `dragEnd`. */
  readonly hold?: boolean;
}

export interface ControllerHarness extends Fakes {
  readonly diagram: Diagram;
  /** Every event the diagram emitted, in order. */
  readonly heard: Heard[];
  /** The live renderer: the last one built. */
  readonly renderer: FakeRenderer;
  /** The live frame loop: the last one built. */
  readonly loop: FakeFrameLoop;
  /** The live gesture adapter. */
  readonly input: FakeGestures;
  /** The live keyboard adapter. */
  readonly keys: FakeKeyboard;
  /** The device of the live binding. */
  readonly device: GPUDevice;
  /** Payloads of one event, in order. */
  emitted<K extends keyof Events>(event: K): Events[K][];
  /** Forget what was heard. */
  clearHeard(): void;
  /** Pump one frame; returns whether it wants another. */
  frame(init?: Partial<Frame>): boolean;
  /** Pump one frame and let its notices arrive. */
  settle(init?: Partial<Frame>): Promise<boolean>;
  /** A part's canvas-local anchor; throws when it has none. */
  at(part: Part): readonly [number, number];
  /** Tap a canvas-local point. */
  tap(sx: number, sy: number, init?: { shift?: boolean; mod?: boolean }): void;
  /** Press at `from` and drag to `to`, canvas-local; released there unless `hold`. */
  drag(from: readonly [number, number], to: readonly [number, number], options?: DragOptions): void;
  /** A canvas-local point `hitTest` finds nothing within `radiusPx` of, away from the edges. */
  empty(radiusPx?: number): readonly [number, number];
  /** Lose the device of the live binding, or the one at `index`. */
  loseDevice(info?: Partial<GPUDeviceLostInfo>, index?: number): void;
  destroy(): void;
}

/** A controller over fakes, listening to every event, attached unless `attach` is false. */
export async function createControllerHarness(
  options: Options = {},
  attach = true,
): Promise<ControllerHarness> {
  const fakes = createFakes();
  const diagram = fakes.create(options);
  const heard: Heard[] = [];
  for (const event of EVENT_NAMES) {
    diagram.on(event, (payload: unknown) => heard.push({ event, payload }));
  }
  if (attach) await diagram.attach(fakes.canvas);

  const last = <T>(list: readonly T[], name: string): T => {
    const item = list[list.length - 1];
    if (item === undefined) throw new Error(`harness: no ${name} yet`);
    return item;
  };

  const harness: ControllerHarness = {
    ...fakes,
    diagram,
    heard,
    get renderer() {
      return last(fakes.renderers, 'renderer');
    },
    get loop() {
      return last(fakes.loops, 'frame loop');
    },
    get input() {
      return last(fakes.gestures, 'gesture adapter');
    },
    get keys() {
      return last(fakes.keyboards, 'keyboard adapter');
    },
    get device() {
      return last(fakes.pool.devices, 'device').device;
    },
    emitted<K extends keyof Events>(event: K): Events[K][] {
      return heard
        .filter((entry) => entry.event === event)
        .map((entry) => entry.payload) as Events[K][];
    },
    clearHeard() {
      heard.length = 0;
    },
    frame(init) {
      return harness.loop.frame(init);
    },
    async settle(init) {
      const more = harness.loop.frame(init);
      await flushMicrotasks();
      return more;
    },
    at(part) {
      const point = diagram.locate(part);
      if (!point) throw new Error(`harness: ${part.kind} ${part.index} has no anchor`);
      return [point[0] - LEFT, point[1] - TOP];
    },
    tap(sx, sy, init = {}) {
      const input = harness.input;
      const shift = init.shift ?? false;
      const mod = init.mod ?? false;
      input.emit({
        kind: 'press',
        sx,
        sy,
        button: 0,
        pointerType: 'mouse',
        shift,
        mod,
        targetPx: 8,
      });
      input.emit({ kind: 'tap', sx, sy, targetPx: 8, shift, mod });
    },
    drag(from, to, dragOptions = {}) {
      const input = harness.input;
      const [sx, sy] = from;
      const [ex, ey] = to;
      input.emit({
        kind: 'press',
        sx,
        sy,
        button: dragOptions.button ?? 0,
        pointerType: dragOptions.pointerType ?? 'mouse',
        shift: dragOptions.shift ?? false,
        mod: false,
        targetPx: 8,
      });
      input.emit({ kind: 'dragStart', sx, sy, time: 0 });
      input.emit({ kind: 'dragMove', sx: ex, sy: ey, dx: ex - sx, dy: ey - sy, time: 16 });
      if (dragOptions.hold) return;
      input.emit({
        kind: 'dragEnd',
        sx: ex,
        sy: ey,
        clientX: ex + LEFT,
        clientY: ey + TOP,
        cancelled: false,
      });
    },
    empty(radiusPx = 24) {
      for (let sy = 60; sy < HEIGHT - 60; sy += 10) {
        for (let sx = 60; sx < WIDTH - 60; sx += 10) {
          if (diagram.hitTest(sx + LEFT, sy + TOP, radiusPx).length === 0) return [sx, sy];
        }
      }
      throw new Error('harness: no empty point on the canvas');
    },
    loseDevice(info = {}, index = fakes.pool.devices.length - 1) {
      fakes.pool.devices[index]!.lost.resolve({
        reason: 'unknown',
        message: 'lost for test',
        ...info,
      } as GPUDeviceLostInfo);
    },
    destroy() {
      diagram.destroy();
    },
  };
  return harness;
}
