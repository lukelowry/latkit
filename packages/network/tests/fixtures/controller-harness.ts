import { vi } from 'vitest';
import type { Presentation } from '@latkit/gpu';

import type { ControllerDeps, Events, Network, Options } from '../../src/controller.js';
import { createNetworkWithDeps } from '../../src/controller.js';
import { createOrbit } from '../../src/orbit.js';
import { packBound, type Channel, type ChannelSlot } from '../../src/channels.js';
import type { Bounds, EncodedTopology } from '../../src/topology/index.js';
import type { EncodedSegments } from '../../src/segments/index.js';
import type { PreparedScene } from '../../src/scene.js';
import type { Surface } from '../../src/input/surface.js';
import type { Intent } from '../../src/input/pointer.js';
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
  visibility = {
    vertices: true,
    edges: true,
    poles: false,
    borders: true,
    earthAxis: true,
  };
  borders: Borders | null = null;
  projectionMode: Projection = 'flat';
  slots: ReadonlyMap<Channel, ChannelSlot> = new Map();
  encodedTopology: EncodedTopology | null = null;
  encodedSegments: EncodedSegments | null = null;
  channelWrites: Array<{ channel: Channel; values: Float32Array }> = [];

  setVisible = vi.fn((opts: Options) => {
    if (opts.vertices !== undefined) this.visibility.vertices = opts.vertices;
    if (opts.edges !== undefined) this.visibility.edges = opts.edges;
    if (opts.poles !== undefined) this.visibility.poles = opts.poles;
    if (opts.borders !== undefined) this.visibility.borders = opts.borders;
    if (opts.earthAxis !== undefined) this.visibility.earthAxis = opts.earthAxis;
  });

  bindTopology = vi.fn((scene: PreparedScene) => {
    this.encodedTopology = scene.topology;
    this.encodedSegments = scene.segments.encoded;
  });

  writeColormap = vi.fn((_lut: Uint8Array) => {});

  setBorders = vi.fn((borders: Borders | null) => {
    this.borders = borders;
  });

  relayout = vi.fn(
    (
      bound: ReadonlySet<Channel>,
      vertexCount: number,
      edgeCount: number,
      values?: ReadonlyMap<Channel, Float32Array>,
    ): ReadonlyMap<Channel, ChannelSlot> => {
      this.slots = packBound(bound, vertexCount, edgeCount).slot;
      if (values)
        for (const [channel, channelValues] of values) this.writeChannel(channel, channelValues);
      return this.slots;
    },
  );

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

  setBounds = vi.fn((bounds: Bounds | null) => {
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

export interface ControllerHarness {
  readonly network: Network;
  readonly deps: ControllerDeps;
  readonly renderer: FakeRenderer;
  readonly loop: FakeRenderLoop;
  readonly rig: FakeCameraRig;
  readonly picker: FakePicker;
  readonly canvas: HTMLCanvasElement;
  readonly surface: FakeSurface;
  readonly pointerCleanup: { destroy: ReturnType<typeof vi.fn> };
  readonly device: GPUDevice;
  readonly presentation: Presentation<HTMLCanvasElement>;
  readonly deviceDestroy: ReturnType<typeof vi.fn>;
  readonly deviceLost: Deferred<GPUDeviceLostInfo>;
  readonly events: {
    readonly deviceLost: Events['deviceLost'][];
  };
  emitPointer(intent: Intent): void;
  destroy(): void;
}

export async function createControllerHarness(
  options: Options = {},
  configure?: (deps: ControllerDeps) => void,
): Promise<ControllerHarness> {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('width', '320');
  canvas.setAttribute('height', '180');
  document.body.append(canvas);
  const surface = makeSurface(canvas);
  const deviceLost = deferred<GPUDeviceLostInfo>();
  const deviceDestroy = vi.fn();
  const device = {
    limits: {},
    lost: deviceLost.promise,
    destroy: deviceDestroy,
  } as unknown as GPUDevice;
  const presentation = makePresentation(device, canvas);

  const renderer = new FakeRenderer();
  const loop = new FakeRenderLoop();
  const rig = new FakeCameraRig();
  const picker = new FakePicker();
  const events = { deviceLost: [] as Events['deviceLost'][] };

  let emitPointer: ((intent: Intent) => void) | null = null;
  const pointerCleanup = { destroy: vi.fn() };

  const deps: ControllerDeps = {
    createSurface: vi.fn(() => surface),
    createPresentation: vi.fn(() => presentation),
    Renderer: vi.fn(() => renderer as unknown as Renderer) as unknown as typeof Renderer,
    RenderLoop: vi.fn(
      (renderLoopDeps: RenderLoopDeps) => loop.attach(renderLoopDeps) as unknown as RenderLoop,
    ) as unknown as typeof RenderLoop,
    CameraRig: vi.fn(() => rig as unknown as CameraRig) as unknown as typeof CameraRig,
    attachPointer: vi.fn((_surface: Surface, emit: (intent: Intent) => void) => {
      emitPointer = emit;
      return pointerCleanup;
    }),
    Picker: vi.fn((pickerDeps: PickerDeps) => {
      picker.deps = pickerDeps;
      return picker as unknown as Picker;
    }) as unknown as typeof Picker,
    createOrbit,
  };
  configure?.(deps);

  const network = await createNetworkWithDeps(device, canvas, options, deps);
  network.on('deviceLost', (loss) => events.deviceLost.push(loss));

  return {
    network,
    deps,
    renderer,
    loop,
    rig,
    picker,
    canvas,
    surface,
    pointerCleanup,
    device,
    presentation,
    deviceDestroy,
    deviceLost,
    events,
    emitPointer(intent: Intent) {
      if (!emitPointer) throw new Error('pointer not attached');
      emitPointer(intent);
    },
    destroy() {
      network.destroy();
    },
  };
}
