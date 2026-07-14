import { vi } from 'vitest';
import type { Presentation } from '@latkit/gpu';

import type { ControllerDeps, Events, Network, Options } from '../../src/controller.js';
import { createNetworkWithDeps } from '../../src/controller.js';
import { packBound, type Channel, type ChannelSlot } from '../../src/channels.js';
import type { Bounds, EncodedTopology } from '../../src/topology/index.js';
import type { EncodedSegments } from '../../src/segments/index.js';
import type { Surface } from '../../src/input/surface.js';
import type { Intent } from '../../src/input/pointer.js';
import type { Picker, PickerDeps, PickQuery, PickResult } from '../../src/pick/picker.js';
import type { ProjectionMode } from '../../src/projections.js';
import type { Viewport } from '../../src/camera/projection.js';
import type { Renderer } from '../../src/webgpu/renderer.js';
import type { RenderLoop, RenderLoopDeps } from '../../src/webgpu/render-loop.js';
import type { ProjectionRig } from '../../src/camera/rig.js';
import type { Uniforms } from '../../src/webgpu/uniforms.js';
import type { Borders } from '../../src/borders.js';

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
  onProjectionPipelinesReady?: () => void;
  visibility = {
    vertices: true,
    edges: true,
    poles: false,
    borders: true,
    earthAxis: true,
  };
  borders: Borders | null = null;
  projectionMode: ProjectionMode = 'flat';
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

  bindTopology = vi.fn((encoded: EncodedTopology, encodedSegments: EncodedSegments) => {
    this.encodedTopology = encoded;
    this.encodedSegments = encodedSegments;
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
    ): ReadonlyMap<Channel, ChannelSlot> => {
      this.slots = packBound(bound, vertexCount, edgeCount).slot;
      return this.slots;
    },
  );

  writeChannel = vi.fn((channel: Channel, values: Float32Array) => {
    this.channelWrites.push({ channel, values });
  });

  useProjectionPipelines = vi.fn((mode: ProjectionMode) => {
    this.projectionMode = mode;
  });

  destroy = vi.fn();
}

export class FakeCamera {
  screenToWorld = vi.fn((_sx: number, _sy: number, _vp: Viewport): readonly [number, number] => [
    0, 0,
  ]);
  isAnimating = vi.fn(() => false);
  beginDrag = vi.fn();
  drag = vi.fn();
  endDrag = vi.fn();
  panBy = vi.fn();
  zoomAt = vi.fn();
  rotateBy = vi.fn();
  fitView = vi.fn();
}

export class FakeProjectionRig {
  mode: ProjectionMode = 'flat';
  camera = new FakeCamera();
  nextSwitchPlaced = true;

  switchTo = vi.fn((mode: ProjectionMode, _bounds: Bounds | null, _vp: Viewport): boolean => {
    this.mode = mode;
    this.camera = new FakeCamera();
    return this.nextSwitchPlaced;
  });
}

export class FakePicker {
  deps: PickerDeps | null = null;
  nextHit: PickResult | null = null;
  nextHits: PickResult[] = [];
  lastQuery: PickQuery | null = null;

  setScene = vi.fn((_encoded: EncodedTopology, _encodedSegments: EncodedSegments) => {});

  pick = vi.fn((query: PickQuery): PickResult | null => {
    this.lastQuery = query;
    return this.nextHit;
  });

  pickAll = vi.fn((query: PickQuery): PickResult[] => {
    this.lastQuery = query;
    return this.nextHits;
  });
}

export class FakeRenderLoop {
  deps: RenderLoopDeps | null = null;
  uniforms!: Uniforms;
  viewport: Viewport = { w: 100, h: 80 };
  bounds: Bounds | null = null;

  attach(deps: RenderLoopDeps): this {
    this.deps = deps;
    this.uniforms = deps.uniforms;
    return this;
  }

  setCamera = vi.fn();
  wake = vi.fn();
  requestFit = vi.fn();
  frameNow = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  destroy = vi.fn();

  setBounds = vi.fn((bounds: Bounds) => {
    this.bounds = bounds;
  });

  frame(vp: Viewport = this.viewport): void {
    this.deps?.onBeforeFrame?.(vp);
    this.deps?.onFrame?.();
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
  readonly rig: FakeProjectionRig;
  readonly picker: FakePicker;
  readonly canvas: HTMLCanvasElement;
  readonly surface: FakeSurface;
  readonly pointerCleanup: { destroy: ReturnType<typeof vi.fn> };
  readonly device: GPUDevice;
  readonly presentation: Presentation<HTMLCanvasElement>;
  readonly deviceDestroy: ReturnType<typeof vi.fn>;
  readonly deviceLost: Deferred<GPUDeviceLostInfo>;
  readonly events: {
    readonly deviceLost: Array<Parameters<Events['deviceLost']>>;
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
  const rig = new FakeProjectionRig();
  const picker = new FakePicker();
  const events = { deviceLost: [] as Array<Parameters<Events['deviceLost']>> };

  let emitPointer: ((intent: Intent) => void) | null = null;
  const pointerCleanup = { destroy: vi.fn() };

  const deps: ControllerDeps = {
    createSurface: vi.fn(() => surface),
    createPresentation: vi.fn(() => presentation),
    Renderer: vi.fn(() => renderer as unknown as Renderer) as unknown as typeof Renderer,
    RenderLoop: vi.fn(
      (renderLoopDeps: RenderLoopDeps) => loop.attach(renderLoopDeps) as unknown as RenderLoop,
    ) as unknown as typeof RenderLoop,
    ProjectionRig: vi.fn(() => rig as unknown as ProjectionRig) as unknown as typeof ProjectionRig,
    attachPointer: vi.fn((_surface: Surface, emit: (intent: Intent) => void) => {
      emitPointer = emit;
      return pointerCleanup;
    }),
    Picker: vi.fn((pickerDeps: PickerDeps) => {
      picker.deps = pickerDeps;
      return picker as unknown as Picker;
    }) as unknown as typeof Picker,
  };
  configure?.(deps);

  const network = await createNetworkWithDeps(device, canvas, options, deps);
  network.on('deviceLost', (reason, message) => events.deviceLost.push([reason, message]));

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
