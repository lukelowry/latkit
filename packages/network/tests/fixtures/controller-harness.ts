import { vi } from 'vitest';
import type { DeviceLease, DevicePool, Presentation } from '@latkit/gpu';

import type { ControllerDeps, Events, Network, Options } from '../../src/controller.js';
import { createNetworkWithDeps } from '../../src/controller.js';
import { createOrbit } from '../../src/orbit.js';
import type { Channel } from '../../src/channels.js';
import type { Bounds, EncodedTopology } from '../../src/topology/index.js';
import type { EncodedSegments } from '../../src/segments/index.js';
import type { PreparedScene } from '../../src/scene.js';
import type { Surface } from '../../src/input/surface.js';
import type { Intent, PointerPolicy, WheelPolicy } from '../../src/input/pointer.js';
import type { FramePasses } from '../../src/webgpu/frame-encoder.js';
import type { KeyIntent } from '../../src/input/keyboard.js';
import type { Picker, PickerDeps, PickQuery, PickResult } from '../../src/pick/picker.js';
import type { Projection } from '../../src/projections.js';
import type { Viewport } from '../../src/camera/projection.js';
import type { Renderer } from '../../src/webgpu/renderer.js';
import type { RenderLoop, RenderLoopDeps } from '../../src/webgpu/render-loop.js';
import type { CameraRig } from '../../src/camera/rig.js';
import type { RevealResult } from '../../src/camera/camera.js';
import type { Uniforms } from '../../src/webgpu/uniforms.js';
import type { Borders } from '../../src/borders/index.js';

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

export function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

export class FakeRenderer {
  onPipelinesReady?: () => void;
  onPipelineError?: (family: 'plane' | 'globe', cause: unknown) => void;
  passes: FramePasses = {
    vertices: true,
    edges: true,
    poles: false,
    borders: true,
    earthAxis: true,
    layering: 'stacked',
  };
  borders: Borders | null = null;
  projectionMode: Projection = 'flat';
  encodedTopology: EncodedTopology | null = null;
  encodedSegments: EncodedSegments | null = null;
  channelWrites: Array<{ channel: Channel; values: Float32Array }> = [];

  setPasses = vi.fn((passes: Partial<FramePasses>) => {
    Object.assign(this.passes, passes);
  });

  bindTopology = vi.fn((scene: PreparedScene) => {
    this.encodedTopology = scene.topology;
    this.encodedSegments = scene.segments.encoded;
  });

  writeColormap = vi.fn((_lut: Uint8Array) => {});

  setBorders = vi.fn((borders: Borders | null) => {
    this.borders = borders;
  });

  writeChannel = vi.fn((channel: Channel, values: Float32Array) => {
    this.channelWrites.push({ channel, values });
  });

  useProjection = vi.fn((mode: Projection) => {
    this.projectionMode = mode;
  });

  warmProjection = vi.fn((_mode: Projection): Promise<void> => Promise.resolve());

  destroy = vi.fn();
}

export class FakeCamera {
  current = Float64Array.of(0, 0, 1);
  placed = true;
  screenToWorld = vi.fn(
    (_sx: number, _sy: number, _vp: Viewport): readonly [number, number] | null => [0, 0],
  );
  isAnimating = vi.fn(() => false);
  beginDrag = vi.fn(() => true);
  drag = vi.fn(() => true);
  endDrag = vi.fn(() => true);
  panBy = vi.fn(() => true);
  zoomAt = vi.fn(() => true);
  rotateBy = vi.fn(() => true);
  pose = vi.fn(() => ({ centerX: 0, centerY: 0, pitch: 0, bearing: 0 }));
  setPose = vi.fn(() => true);
  fitView = vi.fn();
  moveTo = vi.fn((_bounds: Bounds, _viewport: Viewport, _animate: boolean) => true);
  reveal = vi.fn(
    (_bounds: Bounds, _viewport: Viewport, _animate: boolean): RevealResult => 'moved',
  );
  claimCurrent = vi.fn(() => false);
}

export class FakeCameraRig {
  mode: Projection = 'flat';
  camera = new FakeCamera();
  bounds: Bounds | null = null;
  pendingPlacement = false;
  nextClaim = false;
  animationMs = 500;

  setBounds = vi.fn((bounds: Bounds | null, _fit?: boolean) => {
    this.bounds = bounds;
  });

  fit = vi.fn((_vp: Viewport, _animate: boolean) => {});
  moveTo = vi.fn((_bounds: Bounds, _vp: Viewport, _animate: boolean) => {});
  reveal = vi.fn((_bounds: Bounds, _vp: Viewport, _animate: boolean) => {});
  claim = vi.fn((): boolean => this.nextClaim);

  switchTo = vi.fn((mode: Projection, _vp: Viewport) => {
    this.mode = mode;
    this.camera = new FakeCamera();
  });

  tick = vi.fn((_now: number, _vp: Viewport): boolean => this.bounds !== null);
  isAnimating = vi.fn(() => this.camera.isAnimating());
  isAtFitView = vi.fn(() => false);
}

export class FakePicker {
  deps: PickerDeps | null = null;
  nextHit: PickResult | null = null;
  nextHits: PickResult[] = [];
  lastQuery: PickQuery | null = null;
  nextLocation: readonly [number, number] | null = null;
  nextLocationVisible = true;
  lastLocate: readonly [PickResult, Viewport] | null = null;
  scene: PreparedScene | null = null;

  prepareScene = vi.fn((scene: PreparedScene) => scene);

  commitScene = vi.fn((scene: PreparedScene | null) => {
    this.scene = scene;
  });

  pick = vi.fn((query: PickQuery): PickResult | null => {
    this.lastQuery = query;
    return this.nextHit;
  });

  pickAll = vi.fn((query: PickQuery): PickResult[] => {
    this.lastQuery = query;
    return this.nextHits;
  });

  locate = vi.fn((item: PickResult, viewport: Viewport): readonly [number, number] | null => {
    this.lastLocate = [item, viewport];
    return this.nextLocation;
  });

  locateDetail = vi.fn(
    (
      item: PickResult,
      viewport: Viewport,
    ): { readonly point: readonly [number, number]; readonly visible: boolean } | null => {
      this.lastLocate = [item, viewport];
      return this.nextLocation
        ? { point: this.nextLocation, visible: this.nextLocationVisible }
        : null;
    },
  );
}

export class FakeRenderLoop {
  deps: RenderLoopDeps | null = null;
  uniforms!: Uniforms;
  viewport: Viewport = { w: 100, h: 80 };

  attach(deps: RenderLoopDeps): this {
    this.deps = deps;
    this.uniforms = deps.uniforms;
    return this;
  }

  wake = vi.fn();
  frameNow = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  destroy = vi.fn();

  frame(vp: Viewport = this.viewport, sizeSettled = true): void {
    this.deps?.onBeforeFrame?.(vp);
    this.deps?.onFrame?.(sizeSettled);
  }

  paint(): void {
    this.deps?.onPaint?.();
  }
}

export interface FakeSurface extends Surface {
  readonly destroy: ReturnType<typeof vi.fn>;
  viewport: Viewport;
}

function makeSurface(element: HTMLCanvasElement): FakeSurface {
  const destroy = vi.fn();
  return {
    element,
    viewport: { w: 100, h: 80 },
    size() {
      return this.viewport;
    },
    rect() {
      return new DOMRect(0, 0, this.viewport.w, this.viewport.h);
    },
    destroy,
  };
}

function makePresentation(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
): Presentation<HTMLCanvasElement> {
  const width = canvas.getAttribute('width');
  const height = canvas.getAttribute('height');
  let destroyed = false;

  return {
    canvas,
    device,
    context: { canvas } as unknown as GPUCanvasContext,
    format: 'bgra8unorm',
    resize: vi.fn((nextWidth: number, nextHeight: number) => {
      if (destroyed) return false;
      const changed = canvas.width !== nextWidth || canvas.height !== nextHeight;
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      return changed;
    }),
    observe: vi.fn((listener: (width: number, height: number, pixelRatio: number) => void) => {
      if (!destroyed) listener(canvas.width, canvas.height, 1);
      return () => {};
    }),
    destroy: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      if (width === null) canvas.removeAttribute('width');
      else canvas.setAttribute('width', width);
      if (height === null) canvas.removeAttribute('height');
      else canvas.setAttribute('height', height);
    }),
  };
}

/** One fake device with its loss signal and destroy spy. */
export interface FakeDevice {
  readonly device: GPUDevice;
  readonly lost: Deferred<GPUDeviceLostInfo>;
  readonly destroy: ReturnType<typeof vi.fn>;
}

export function fakeDevice(limits: Partial<GPUSupportedLimits> = {}): FakeDevice {
  const lost = deferred<GPUDeviceLostInfo>();
  const destroy = vi.fn();
  return {
    device: { limits, lost: lost.promise, destroy } as unknown as GPUDevice,
    lost,
    destroy,
  };
}

/** A pool that mints one fake device per acquisition and counts every lease release. */
export interface FakePool extends DevicePool {
  readonly devices: FakeDevice[];
  readonly releases: ReturnType<typeof vi.fn>;
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
  return {
    devices,
    releases,
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
      const entry = fakeDevice();
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
}

export interface ControllerHarness {
  readonly network: Network;
  readonly deps: ControllerDeps;
  readonly pool: FakePool;
  readonly renderer: FakeRenderer;
  readonly loop: FakeRenderLoop;
  readonly rig: FakeCameraRig;
  readonly picker: FakePicker;
  readonly canvas: HTMLCanvasElement;
  readonly surface: FakeSurface;
  readonly pointerCleanup: { destroy: ReturnType<typeof vi.fn> };
  readonly keyboardCleanup: { destroy: ReturnType<typeof vi.fn> };
  readonly presentations: Presentation<HTMLCanvasElement>[];
  readonly events: {
    readonly deviceLost: Events['deviceLost'][];
    readonly attached: boolean[];
  };
  /** The device of the live binding. */
  readonly device: GPUDevice;
  readonly presentation: Presentation<HTMLCanvasElement>;
  /** Lose the device of the live binding, or the one at `index`. */
  loseDevice(info?: Partial<GPUDeviceLostInfo>, index?: number): void;
  /** The wheel policy the pointer adapter was given. */
  readonly wheelPolicy: WheelPolicy | null;
  /** The live pick radius the pointer adapter was given. */
  readonly pickRadiusPx: (() => number) | null;
  emitPointer(intent: Intent): void;
  emitKey(intent: KeyIntent): void;
  destroy(): void;
}

export async function createControllerHarness(
  options: Options = {},
  configure?: (deps: ControllerDeps) => void,
  attach = true,
): Promise<ControllerHarness> {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('width', '320');
  canvas.setAttribute('height', '180');
  document.body.append(canvas);
  const surface = makeSurface(canvas);
  const pool = fakePool();
  const presentations: Presentation<HTMLCanvasElement>[] = [];

  const renderer = new FakeRenderer();
  const loop = new FakeRenderLoop();
  const rig = new FakeCameraRig();
  const picker = new FakePicker();
  const events = { deviceLost: [] as Events['deviceLost'][], attached: [] as boolean[] };

  let emitPointer: ((intent: Intent) => void) | null = null;
  let emitKey: ((intent: KeyIntent) => void) | null = null;
  let wheelPolicy: WheelPolicy | null = null;
  let pickRadiusPx: (() => number) | null = null;
  const pointerCleanup = { destroy: vi.fn() };
  const keyboardCleanup = { destroy: vi.fn() };

  const deps: ControllerDeps = {
    createSurface: vi.fn(() => surface),
    createPresentation: vi.fn((device: GPUDevice, target: HTMLCanvasElement) => {
      const presentation = makePresentation(device, target);
      presentations.push(presentation);
      return presentation;
    }),
    Renderer: vi.fn(() => renderer as unknown as Renderer) as unknown as typeof Renderer,
    RenderLoop: vi.fn(
      (renderLoopDeps: RenderLoopDeps) => loop.attach(renderLoopDeps) as unknown as RenderLoop,
    ) as unknown as typeof RenderLoop,
    CameraRig: vi.fn(() => rig as unknown as CameraRig) as unknown as typeof CameraRig,
    attachPointer: vi.fn(
      (_surface: Surface, emit: (intent: Intent) => void, policy?: Partial<PointerPolicy>) => {
        emitPointer = emit;
        wheelPolicy = policy?.wheel ?? null;
        pickRadiusPx = policy?.pickRadiusPx ?? null;
        return pointerCleanup;
      },
    ),
    attachKeyboard: vi.fn((_canvas: HTMLCanvasElement, emit: (intent: KeyIntent) => void) => {
      emitKey = emit;
      return keyboardCleanup;
    }),
    Picker: vi.fn((pickerDeps: PickerDeps) => {
      picker.deps = pickerDeps;
      return picker as unknown as Picker;
    }) as unknown as typeof Picker,
    createOrbit,
  };
  configure?.(deps);

  const network = createNetworkWithDeps({ devices: pool, ...options }, deps);
  network.on('deviceLost', (loss) => events.deviceLost.push(loss));
  network.on('attached', (state) => events.attached.push(state));
  if (attach) await network.attach(canvas);

  return {
    network,
    deps,
    pool,
    renderer,
    loop,
    rig,
    picker,
    canvas,
    surface,
    pointerCleanup,
    keyboardCleanup,
    presentations,
    events,
    get device() {
      return pool.devices[pool.devices.length - 1]!.device;
    },
    get presentation() {
      return presentations[presentations.length - 1]!;
    },
    get wheelPolicy() {
      return wheelPolicy;
    },
    get pickRadiusPx() {
      return pickRadiusPx;
    },
    loseDevice(info = {}, index = pool.devices.length - 1) {
      pool.devices[index]!.lost.resolve({
        reason: 'unknown',
        message: 'lost for test',
        ...info,
      } as GPUDeviceLostInfo);
    },
    emitPointer(intent: Intent) {
      if (!emitPointer) throw new Error('pointer not attached');
      emitPointer(intent);
    },
    emitKey(intent: KeyIntent) {
      if (!emitKey) throw new Error('keyboard not attached');
      emitKey(intent);
    },
    destroy() {
      network.destroy();
    },
  };
}
