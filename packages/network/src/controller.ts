/// <reference types="@webgpu/types" />

import { createPresentation, type Presentation } from '@latkit/gpu';

import {
  encodeTopology,
  readEncodedTopologyInfo,
  type Bounds,
  type Topology,
} from './topology/index.js';
import { encodeSegments } from './segments/index.js';
import { Renderer } from './webgpu/renderer.js';
import { createUniforms, FLAG_DAYLIGHT, FLAG_GRATICULE } from './webgpu/uniforms.js';
import { FocusState, type FocusStyle, type RGBA } from './focus-state.js';
import { VISUAL, planeHeightWorldScale } from './visual.js';
import { ProjectionRig } from './camera/rig.js';
import { attachPointer, type HoverProbe } from './input/pointer.js';
import { createSurface } from './input/surface.js';
import type { Viewport } from './camera/projection.js';
import { CHANNEL_DEFINITIONS, createChannels, type Channel } from './channels.js';
import type { ChannelRange } from './range.js';
import { RenderLoop } from './webgpu/render-loop.js';
import { PROJECTIONS, PROJECTION_MODES, type ProjectionMode } from './projections.js';
import type { Borders } from './borders.js';
import { createEmitter } from './emitter.js';
import { edgeCountOf } from './topology/pack.js';
import { Picker, type PickQuery, type PickResult } from './pick/picker.js';
import {
  DEFAULT_OPTIONS,
  OPTION_DEFINITIONS,
  resolveOptions,
  validateOptions,
  type Options,
  type ResolvedOptions,
} from './options.js';

export type { Options } from './options.js';

/**
 * Events emitted by a {@link Network} instance.
 *
 * @remarks
 * `hover` and `select` use `null` values to report cleared interaction state.
 * Programmatic selection methods do not emit `select`; user pointer selection
 * does emit it.
 */
export type Events = {
  /** Hovered vertex or edge; null kind and index after hover exit. */
  hover: (kind: 'vertex' | 'edge' | null, index: number | null) => void;
  /** User-selected vertex or edge; null kind and index after selection clear. */
  select: (kind: 'vertex' | 'edge' | null, index: number | null) => void;
  /** Camera zoom state after a fit-view transition or gesture. */
  zoom: (atFitView: boolean) => void;
  /** WebGPU device-loss notification surfaced before rendering pauses. */
  deviceLost: (reason: string, message: string) => void;
};

/**
 * Imperative controller for a WebGPU network canvas.
 *
 * @remarks
 * The controller borrows the canvas and device passed to {@link createNetwork};
 * it never removes the canvas or destroys the device. It owns its pointer
 * handlers, render loop, and renderer-created GPU resources. Call
 * {@link Network.destroy} before removing the canvas. Load topology before
 * binding channels or reading projection availability.
 */
export interface Network {
  /** Projection modes currently supported by the loaded topology. */
  readonly projections: Readonly<Record<ProjectionMode, boolean>>;
  /**
   * Subscribe to a network event and receive an unsubscribe callback.
   *
   * @param event - Event name to observe.
   * @param handler - Callback invoked with the event payload.
   * @returns A function that removes the handler.
   */
  on<K extends keyof Events>(event: K, handler: Events[K]): () => void;
  /**
   * Bind a topology and schedule its first paint.
   *
   * This method is synchronous; read `Network.projections` immediately
   * after it returns. Throws when topology validation or GPU binding fails,
   * leaving the prior view intact.
   *
   * @param topology - CPU-side graph and geometry arrays.
   * @throws Error when topology validation or GPU binding fails.
   */
  load(topology: Topology): void;
  /**
   * Replace the optional geographic border overlay.
   *
   * @param borders - Packed border geometry, or `null` to clear borders.
   */
  setBorders(borders: Borders | null): void;
  /**
   * Replace the color lookup table used by colormap channels.
   *
   * @param fn - Function mapping normalized values in `[0, 1]` to RGB channels in `[0, 1]`.
   */
  setColormap(fn: NonNullable<Options['colormap']>): void;
  /**
   * Set the default vertex color used without a `vertexColor` channel.
   *
   * @param color - RGBA color with normalized channels in `[0, 1]`.
   */
  setBaseColor(color: RGBA): void;
  /**
   * Bind or replace a per-vertex or per-edge rendering channel.
   *
   * `domain` is the input value range. Height channels may also pass an
   * output `range`; use null for `domain` to keep the auto-scanned input range.
   *
   * @param channel - Channel name to bind.
   * @param values - Scalar values whose length matches the current topology.
   * @param domain - Input domain used for normalization, or `null` for height auto-scan.
   * @param range - Output range for `vertexHeight`; ignored by other channels.
   * @throws Error when no topology is loaded or the array length is invalid.
   */
  setChannel(
    channel: Channel,
    values: Float32Array,
    domain?: ChannelRange | null,
    range?: ChannelRange,
  ): void;
  /**
   * Clear a previously bound rendering channel.
   *
   * @param channel - Channel name to clear.
   */
  clearChannel(channel: Channel): void;
  /**
   * Override the input domain used to normalize a non-dash channel.
   *
   * @param channel - Channel name to update.
   * @param range - Fixed input range, or `null` to return to the scanned/default domain.
   */
  setChannelRange(channel: Channel, range: ChannelRange | null): void;
  /**
   * Update display options. `msaa` remains construction-only.
   *
   * @param options - Partial display option patch.
   */
  setOptions(options: Options): void;
  /**
   * Fit the loaded topology into the current viewport.
   *
   * @param animate - If true, animate toward the fit view when a viewport is available.
   */
  fit(animate?: boolean): void;
  /**
   * Switch projection mode.
   *
   * @param mode - Projection mode to activate.
   * @returns True if the loaded topology supports the mode; false otherwise.
   */
  setProjection(mode: ProjectionMode): boolean;
  /**
   * Programmatically select an item without emitting a `select` event.
   *
   * @param kind - Item kind to select.
   * @param index - Vertex or edge index.
   */
  select(kind: 'vertex' | 'edge', index: number): void;
  /** Clear selection without emitting a select event. */
  clearSelection(): void;
  /**
   * Pan the active camera by screen pixels.
   *
   * @param dx - Horizontal delta in CSS pixels.
   * @param dy - Vertical delta in CSS pixels.
   */
  panBy(dx: number, dy: number): void;
  /**
   * Zoom the active camera around the viewport center.
   *
   * @param factor - Multiplicative zoom factor.
   */
  zoomBy(factor: number): void;
  /**
   * Fade the canvas in after the first real frame has painted.
   *
   * @param ms - Transition duration in milliseconds. Default: `150`.
   */
  fadeIn(ms?: number): void;
  /** Pause animation and rendering until resumed. */
  pause(): void;
  /** Resume rendering when the page and GPU device allow it. */
  resume(): void;
  /** Release renderer resources and DOM state without removing the canvas or destroying the device. */
  destroy(): void;
}

/** Strip construction-only values from one validated live option patch. */
function runtimeOptionPatch(options: Options): Options {
  const patch: Options = {};
  const source = options as Readonly<Record<string, unknown>>;
  const target = patch as Record<string, unknown>;
  for (const [key, definition] of Object.entries(OPTION_DEFINITIONS)) {
    if (definition.lifecycle === 'runtime' && source[key] !== undefined) target[key] = source[key];
  }
  return patch;
}

/** Internal collaborator seam used by controller behavior tests. */
export interface ControllerDeps {
  createSurface: typeof createSurface;
  createPresentation(device: GPUDevice, canvas: HTMLCanvasElement): Presentation<HTMLCanvasElement>;
  Renderer: typeof Renderer;
  RenderLoop: typeof RenderLoop;
  ProjectionRig: typeof ProjectionRig;
  attachPointer: typeof attachPointer;
  Picker: typeof Picker;
}

const DEFAULT_CONTROLLER_DEPS: ControllerDeps = {
  createSurface,
  createPresentation,
  Renderer,
  RenderLoop,
  ProjectionRig,
  attachPointer,
  Picker,
};

/** Screen-space threshold used by shaders for vertex level-of-detail behavior. */
const VERTEX_LOD_PX = 2;

/** Default opacity transition length used by {@link Network.fadeIn}. */
const FADE_IN_MS = 150;

/** Wake cadence for globe daylight updates while the globe is visible. */
const SUN_REFRESH_MS = 30_000;

/** Number of entries in the renderer's one-dimensional colormap texture. */
const COLORMAP_LUT_SIZE = 256;

/** Converts a clamped 0..1 color component into an 8-bit LUT value. */
const u8 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 255);

/**
 * Creates a WebGPU network renderer on a caller-owned canvas.
 *
 * @param device - Borrowed Core WebGPU device. The caller retains ownership.
 * @param canvas - Borrowed canvas used for presentation and pointer input.
 * @param options - Initial rendering and interaction options.
 * @returns A controller for loading topology, binding channels, and releasing GPU resources.
 * @throws TypeError when `device` does not provide Core WebGPU features and limits.
 * @throws Error when canvas presentation or renderer initialization fails.
 *
 * @example
 * ```ts
 * const network = await createNetwork(device, canvas, { graticule: true });
 * network.load(topology);
 * network.fadeIn();
 * ```
 *
 * The returned controller owns its renderer resources, but not `canvas` or
 * `device`. Destroy the controller before removing the canvas or destroying the
 * borrowed device.
 */
export async function createNetwork(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  options: Options = {},
): Promise<Network> {
  return createNetworkWithDeps(device, canvas, options, DEFAULT_CONTROLLER_DEPS);
}

/** @internal */
export async function createNetworkWithDeps( // eslint-disable-line @typescript-eslint/require-await -- Match the public Promise contract.
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  options: Options,
  deps: ControllerDeps,
): Promise<Network> {
  const resolvedOptions = resolveOptions(options);
  assertDeviceLimits(device);
  const lifecycle = createControllerLifecycle();
  try {
    return createNetworkController(device, canvas, resolvedOptions, deps, lifecycle);
  } catch (error) {
    lifecycle.destroy();
    throw error;
  }
}

/** Rejects devices known not to meet the renderer's Core WebGPU limits. */
function assertDeviceLimits(device: GPUDevice): void {
  const vertexStorage = device.limits.maxStorageBuffersInVertexStage;
  if (vertexStorage !== undefined && vertexStorage < 3) {
    throw new TypeError('A Core WebGPU device is required');
  }
}

/** Resources registered transactionally while a controller is constructed. */
interface ControllerLifecycle {
  add(cleanup: () => void): void;
  destroy(): void;
}

/** Creates an idempotent, reverse-order controller cleanup stack. */
function createControllerLifecycle(): ControllerLifecycle {
  const cleanups: Array<() => void> = [];
  let destroyed = false;

  return {
    add(cleanup) {
      cleanups.push(cleanup);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try {
          cleanups[i]!();
        } catch {
          // Cleanup is best-effort so one resource cannot strand the remainder.
        }
      }
      cleanups.length = 0;
    },
  };
}

/** Relays one device-loss notification without retaining a destroyed controller. */
function forwardDeviceLoss(
  device: GPUDevice,
  listener: (info: GPUDeviceLostInfo) => void,
): () => void {
  let active: ((info: GPUDeviceLostInfo) => void) | undefined = listener;
  void device.lost.then((info) => active?.(info));
  return () => {
    active = undefined;
  };
}

/** Creates the controller after the Promise boundary has established transactional cleanup. */
function createNetworkController(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  options: ResolvedOptions,
  deps: ControllerDeps,
  lifecycle: ControllerLifecycle,
): Network {
  const events = createEmitter<Events>();
  lifecycle.add(events.clear);
  const surface = deps.createSurface(canvas);
  lifecycle.add(() => surface.destroy());
  const originalCanvasState = {
    opacity: canvas.style.opacity,
    transition: canvas.style.transition,
  };
  canvas.style.opacity = '0';
  lifecycle.add(() => {
    canvas.style.opacity = originalCanvasState.opacity;
    canvas.style.transition = originalCanvasState.transition;
  });

  const presentation = deps.createPresentation(device, canvas);
  lifecycle.add(() => presentation.destroy());
  const uniforms = createUniforms();
  const renderer = new deps.Renderer(presentation, options.msaa);
  lifecycle.add(() => renderer.destroy());

  /**
   * First-paint gate for fadeIn requests.
   *
   * The canvas starts hidden and should become visible only after content has
   * actually painted, so load(); fadeIn() never reveals a blank compiling frame.
   */
  let hasPainted = false;
  let pendingFadeMs: number | null = null;

  const loop = new deps.RenderLoop({
    presentation,
    uniforms,
    renderer,
    onZoom: (atFitView) => stageZoomNotice(atFitView),
    onBeforeFrame: (frameVp) => updateHeightWorldScale(frameVp),
    onFrame: (sizeSettled) => resolveHover(sizeSettled),
    onPaint: () => onSuccessfulPaint(),
  });
  lifecycle.add(() => loop.destroy());

  renderer.onProjectionPipelinesReady = () => loop.wake();
  /** Schedule a frame for a visual state change. */
  const repaint = (): void => loop.wake();

  const rig = new deps.ProjectionRig(uniforms.projection);
  loop.setCamera(rig.camera);

  let deviceLoss: readonly [reason: string, message: string] | null = null;
  lifecycle.add(
    forwardDeviceLoss(device, (info) => {
      if (deviceLoss) return;
      deviceLoss = [info.reason ?? 'unknown', info.message || 'WebGPU device was lost'];
      loop.pause();
      events.emit('deviceLost', ...deviceLoss);
    }),
  );

  let consumerPaused = false;
  let pageVisible = typeof document !== 'undefined' ? !document.hidden : true;

  /** Keeps loop activity consistent with user pause, page visibility, and device loss. */
  function syncRenderLoopActivity(): void {
    if (!consumerPaused && pageVisible && !deviceLoss) loop.resume();
    else loop.pause();
  }

  /** Mirrors document visibility into render-loop activity. */
  const onVisibilityChange = (): void => {
    pageVisible = !document.hidden;
    syncRenderLoopActivity();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  lifecycle.add(() => document.removeEventListener('visibilitychange', onVisibilityChange));

  /** Mutable display state mirrored into uniforms and renderer visibility. */
  const display = {
    daylight: DEFAULT_OPTIONS.daylight,
    graticule: DEFAULT_OPTIONS.graticule,
    borders: DEFAULT_OPTIONS.borders,
    vertices: DEFAULT_OPTIONS.vertices,
    edges: DEFAULT_OPTIONS.edges,
    poles: DEFAULT_OPTIONS.poles,
    earthAxis: DEFAULT_OPTIONS.earthAxis,
    nightFloor: DEFAULT_OPTIONS.nightFloor,
    surfaceNightFloor: DEFAULT_OPTIONS.surfaceNightFloor,
    terminatorWidth: DEFAULT_OPTIONS.terminatorWidth,
  };

  uniforms.geometry.vertexLod = VERTEX_LOD_PX;
  let focusStyle: FocusStyle = {
    enabled: DEFAULT_OPTIONS.focusEnabled,
    hoverColor: DEFAULT_OPTIONS.hoverColor,
    selectedColor: DEFAULT_OPTIONS.selectedColor,
    hoverAlpha: DEFAULT_OPTIONS.hoverAlpha,
    selectedAlpha: DEFAULT_OPTIONS.selectedAlpha,
    vertexHoverPx: DEFAULT_OPTIONS.vertexHoverPx,
    vertexSelectedPx: DEFAULT_OPTIONS.vertexSelectedPx,
    edgeHoverPx: DEFAULT_OPTIONS.edgeHoverPx,
    edgeSelectedPx: DEFAULT_OPTIONS.edgeSelectedPx,
    endpointMode: DEFAULT_OPTIONS.focusEndpointMode,
  };
  const focus = new FocusState(uniforms, edgeEndpoints, focusStyle);
  applyOptions(options, true);

  let topology: Topology | null = null;
  let topologyBounds: Bounds | null = null;
  let topologyCharacteristicLength: number | null = null;
  let projections = projectionAvailability(null, null);
  let vertexSize = 0;
  /** Latest physical hover point; converted through the current DOMRect per pick. */
  let hoverProbe: HoverProbe | null = null;
  /** Aggregate pointer/wheel navigation lifecycle supplied by the input adapter. */
  let navigationActive = false;
  /** Invalidates only semantic picks, avoiding repeated large-scene queries. */
  let hoverDirty = false;
  type HoverNotice = readonly ['vertex' | 'edge' | null, number | null];
  interface VersionedNotice<T> {
    readonly value: T;
    readonly scene: number;
  }
  /** Focus change awaiting a successful frame submission. */
  let pendingHoverNotice: VersionedNotice<HoverNotice> | undefined;
  /** Latest submitted focus change awaiting post-tick delivery. */
  let readyHoverNotice: VersionedNotice<HoverNotice> | undefined;
  /** Fit-state transition awaiting a successful frame submission. */
  let pendingZoomNotice: VersionedNotice<boolean> | undefined;
  /** Latest submitted fit-state transition awaiting post-tick delivery. */
  let readyZoomNotice: VersionedNotice<boolean> | undefined;
  let noticeDeliveryQueued = false;
  let sceneGeneration = 0;
  let destroyed = false;

  /** Current canvas viewport in CSS pixels. */
  const vp = (): Viewport => surface.size();

  const channels = createChannels(uniforms, renderer, {
    loaded: () => topology !== null,
    vertexCount: () => topology?.vertexCount ?? 0,
    edgeCount: () => (topology ? edgeCountOf(topology) : 0),
  });

  /**
   * CPU picker over a static coordinate-space index.
   *
   * Camera motion updates uniforms and unprojection but never mutates the index.
   */
  const picker = new deps.Picker({
    uniforms,
    mode: () => rig.mode,
    unproject: (sx, sy, view) => rig.camera.screenToWorld(sx, sy, view),
    values: (channel) => channels.values(channel),
  });

  /** Builds a pick query using current visibility and viewport state. */
  const pickQueryAt = (
    sx: number,
    sy: number,
    targetPx: number,
    view: Viewport = vp(),
  ): PickQuery => ({
    sx,
    sy,
    radiusPx: targetPx,
    vp: view,
    vertices: display.vertices,
    edges: display.edges,
    poles: display.poles,
  });

  /** Periodic wake-up for time-varying globe daylight. */
  const sunTimer = setInterval(() => {
    if (display.daylight && rig.mode === 'globe') loop.wake();
  }, SUN_REFRESH_MS);
  lifecycle.add(() => clearInterval(sunTimer));

  const pointerCleanup = deps.attachPointer(surface, (intent) => {
    switch (intent.kind) {
      case 'navigationStart':
        navigationActive = true;
        hoverDirty = true;
        applyHover(null);
        loop.wake();
        break;
      case 'navigationEnd':
        navigationActive = false;
        hoverProbe = intent.probe;
        hoverDirty = true;
        loop.wake();
        break;
      case 'dragStart':
        if (!topology) break;
        rig.camera.beginDrag(intent.sx, intent.sy, intent.vp, intent.time);
        break;
      case 'dragMove':
        if (!topology) break;
        if (rig.camera.drag(intent.dx, intent.dy, intent.sx, intent.sy, intent.vp, intent.time)) {
          loop.wake();
        }
        break;
      case 'dragEnd':
        if (!topology) break;
        if (rig.camera.endDrag(intent.coast, intent.time)) loop.wake();
        break;
      case 'pan':
        if (!topology) break;
        if (rig.camera.panBy(intent.dx, intent.dy, intent.vp)) loop.wake();
        break;
      case 'zoom':
        if (!topology) break;
        if (rig.camera.zoomAt(intent.factor, intent.sx, intent.sy, intent.vp)) loop.wake();
        break;
      case 'rotate':
        if (!topology) break;
        if (rig.camera.rotateBy(intent.dxPx, intent.dyPx, intent.vp)) loop.wake();
        break;
      case 'tap':
        if (!topology) break;
        cycleSelection(picker.pickAll(pickQueryAt(intent.sx, intent.sy, intent.targetPx)));
        break;
      case 'doubleTap':
        if (!topology) break;
        if (topologyBounds) rig.camera.fitView(topologyBounds, intent.vp);
        loop.wake();
        break;
      case 'hover':
        hoverProbe = intent;
        hoverDirty = true;
        loop.wake();
        break;
      case 'hoverEnd':
        hoverProbe = null;
        hoverDirty = false;
        if (applyHover(null)) repaint();
        break;
      default:
        /* v8 ignore next -- compile-time exhaustive pointer intent guard. */
        intent satisfies never;
    }
  });
  lifecycle.add(() => pointerCleanup.destroy());

  /** Public controller facade; all methods keep state changes behind repaint gates. */
  const api: Network = {
    get projections() {
      return projections;
    },

    on(event, handler) {
      const unsubscribe = events.on(event, handler);
      if (event === 'deviceLost' && deviceLoss) {
        try {
          (handler as Events['deviceLost'])(...deviceLoss);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
      return unsubscribe;
    },

    load(next) {
      loadTopology(next);
    },

    setBorders(borders) {
      renderer.setBorders(borders);
      repaint();
    },

    setColormap(fn) {
      updateOptions({ colormap: fn });
    },

    setBaseColor(color) {
      updateOptions({ baseColor: color });
    },

    setChannel(channel, values, domain, range) {
      channels.set(channel, values, domain, range);
      if (channelAffectsPicking(channel)) hoverDirty = true;
      repaint();
    },

    clearChannel(channel) {
      channels.clear(channel);
      if (channelAffectsPicking(channel)) hoverDirty = true;
      repaint();
    },

    setChannelRange(channel, range) {
      channels.setRange(channel, range);
      if (channelAffectsPicking(channel)) hoverDirty = true;
      repaint();
    },

    select(kind, index) {
      applySelection(kind, index);
    },

    clearSelection() {
      applySelection(null);
    },

    setProjection(mode) {
      if (!PROJECTIONS[mode].canUse(topologyBounds, topologyCharacteristicLength)) return false;
      if (mode === rig.mode) return true;
      hoverDirty = true;
      const placed = rig.switchTo(mode, topologyBounds, vp());
      loop.setCamera(rig.camera);
      if (topology && !placed) loop.requestFit();
      updateHeightWorldScale(vp());
      renderer.useProjectionPipelines(mode);
      repaint();
      return true;
    },

    setOptions(options) {
      updateOptions(options);
    },

    fit(animate) {
      if (!topology) return;
      const view = vp();
      if (animate && view.w > 0 && view.h > 0 && topologyBounds) {
        rig.camera.fitView(topologyBounds, view);
      } else {
        loop.requestFit();
      }
      hoverDirty = true;
      loop.wake();
    },

    panBy(dx, dy) {
      if (!topology) return;
      if (!rig.camera.panBy(dx, dy, vp())) return;
      hoverDirty = true;
      loop.wake();
    },

    zoomBy(factor) {
      if (!topology) return;
      const v = vp();
      if (!rig.camera.zoomAt(factor, v.w / 2, v.h / 2, v)) return;
      hoverDirty = true;
      loop.wake();
    },

    fadeIn(ms = FADE_IN_MS) {
      if (hasPainted) revealCanvas(ms);
      else pendingFadeMs = ms;
    },

    pause() {
      consumerPaused = true;
      syncRenderLoopActivity();
    },

    resume() {
      consumerPaused = false;
      syncRenderLoopActivity();
    },

    destroy() {
      destroyed = true;
      pendingHoverNotice = undefined;
      readyHoverNotice = undefined;
      pendingZoomNotice = undefined;
      readyZoomNotice = undefined;
      topology = null;
      topologyBounds = null;
      topologyCharacteristicLength = null;
      lifecycle.destroy();
    },
  };

  /**
   * Reveals the canvas after the first successful paint.
   *
   * Calls made before first paint are latched by pendingFadeMs and flushed by
   * onFirstPaint so the opacity transition starts when content appears.
   */
  function revealCanvas(ms: number): void {
    canvas.style.transition = `opacity ${ms}ms cubic-bezier(0, 0, 0.2, 1)`;
    canvas.style.opacity = '1';
  }

  /** Flushes a pending fade-in request exactly once after the first paint. */
  function onFirstPaint(): void {
    if (hasPainted) return;
    hasPainted = true;
    if (pendingFadeMs !== null) {
      revealCanvas(pendingFadeMs);
      pendingFadeMs = null;
    }
  }

  /**
   * Promotes submitted public state transitions for delivery after the render tick.
   *
   * Keeping host callbacks out of `onFrame` prevents reentrant load/projection
   * mutations from mixing two scenes into one GPU submission.
   */
  function onSuccessfulPaint(): void {
    onFirstPaint();
    let promoted = false;
    if (pendingZoomNotice) {
      readyZoomNotice = pendingZoomNotice;
      pendingZoomNotice = undefined;
      promoted = true;
    }
    if (pendingHoverNotice) {
      readyHoverNotice = pendingHoverNotice;
      pendingHoverNotice = undefined;
      promoted = true;
    }
    if (!promoted || noticeDeliveryQueued) return;
    noticeDeliveryQueued = true;
    queueMicrotask(() => {
      noticeDeliveryQueued = false;
      const zoomNotice = readyZoomNotice;
      const hoverNotice = readyHoverNotice;
      readyZoomNotice = undefined;
      readyHoverNotice = undefined;
      if (destroyed) return;
      // Preserve the pre-submit ordering: zoom state changes precede hover
      // resolution. A zoom listener may replace the scene, in which case the
      // generation check suppresses the now-stale hover notice below.
      if (zoomNotice?.scene === sceneGeneration) events.emit('zoom', zoomNotice.value);
      if (hoverNotice?.scene === sceneGeneration) events.emit('hover', ...hoverNotice.value);
    });
  }

  /** Stage a fit-state event for the frame that submits the new camera state. */
  function stageZoomNotice(atFitView: boolean): void {
    pendingZoomNotice = { value: atFitView, scene: sceneGeneration };
  }

  /** Writes the base vertex color into shared uniforms. */
  function applyBaseColor(color: RGBA): void {
    uniforms.baseVertexColor.set(color);
  }

  /** Samples a user colormap before any renderer state is mutated. */
  function sampleColormap(fn: NonNullable<Options['colormap']>): Uint8Array {
    const lut = new Uint8Array(COLORMAP_LUT_SIZE * 4);
    for (let i = 0; i < COLORMAP_LUT_SIZE; i++) {
      const [r, g, b] = fn(i / (COLORMAP_LUT_SIZE - 1));
      lut[i * 4] = u8(r);
      lut[i * 4 + 1] = u8(g);
      lut[i * 4 + 2] = u8(b);
      lut[i * 4 + 3] = 255;
    }
    return lut;
  }

  /** Validate and apply one public runtime option patch as a single repaint. */
  function updateOptions(opts: Options): void {
    validateOptions(opts);
    const patch = runtimeOptionPatch(opts);
    if (Object.keys(patch).length === 0) return;
    if (applyOptions(patch)) hoverDirty = true;
    repaint();
  }

  /** Applies construction or runtime display options. */
  function applyOptions(opts: Options, initial = false): boolean {
    const colormapLut =
      opts.colormap && (!initial || opts.colormap !== DEFAULT_OPTIONS.colormap)
        ? sampleColormap(opts.colormap)
        : null;
    const pickVisibilityChanged =
      (opts.vertices !== undefined && opts.vertices !== display.vertices) ||
      (opts.edges !== undefined && opts.edges !== display.edges) ||
      (opts.poles !== undefined && opts.poles !== display.poles);
    if (colormapLut) renderer.writeColormap(colormapLut);
    if (opts.baseColor) applyBaseColor(opts.baseColor);
    if (opts.graticuleColor) uniforms.gridColor.set(opts.graticuleColor);
    if (opts.surfaceColor) uniforms.surfaceColor.set(opts.surfaceColor);
    if (opts.borderColor) uniforms.borderColor.set(opts.borderColor);
    if (opts.graticule !== undefined) display.graticule = opts.graticule;
    if (opts.borders !== undefined) display.borders = opts.borders;
    if (opts.vertices !== undefined) display.vertices = opts.vertices;
    if (opts.edges !== undefined) display.edges = opts.edges;
    if (opts.poles !== undefined) display.poles = opts.poles;
    if (opts.earthAxis !== undefined) display.earthAxis = opts.earthAxis;
    if (opts.daylight !== undefined) display.daylight = opts.daylight;
    if (opts.nightFloor !== undefined) display.nightFloor = opts.nightFloor;
    if (opts.surfaceNightFloor !== undefined) display.surfaceNightFloor = opts.surfaceNightFloor;
    if (opts.terminatorWidth !== undefined) display.terminatorWidth = opts.terminatorWidth;
    applyFocusOptions(opts);
    renderer.setVisible({
      vertices: display.vertices,
      edges: display.edges,
      poles: display.poles,
      borders: display.borders,
      earthAxis: display.earthAxis,
    });
    writeDisplayToUniforms();
    return pickVisibilityChanged;
  }

  /** Applies focus-related option fields as a partial patch. */
  function applyFocusOptions(opts: Options): void {
    let next = focusStyle;
    let changed = false;
    const update = <K extends keyof FocusStyle>(key: K, value: FocusStyle[K] | undefined) => {
      if (value === undefined) return;
      if (!changed) next = { ...focusStyle };
      next[key] = value;
      changed = true;
    };

    update('enabled', opts.focusEnabled);
    update('hoverColor', opts.hoverColor ? [...opts.hoverColor] : undefined);
    update('selectedColor', opts.selectedColor ? [...opts.selectedColor] : undefined);
    update('hoverAlpha', opts.hoverAlpha);
    update('selectedAlpha', opts.selectedAlpha);
    update('vertexHoverPx', opts.vertexHoverPx);
    update('vertexSelectedPx', opts.vertexSelectedPx);
    update('edgeHoverPx', opts.edgeHoverPx);
    update('edgeSelectedPx', opts.edgeSelectedPx);
    update('endpointMode', opts.focusEndpointMode);

    if (!changed) return;
    focusStyle = next;
    focus.setStyle(focusStyle);
  }

  /** Writes display flags and lighting scalars into projection uniforms. */
  function writeDisplayToUniforms(): void {
    uniforms.projection.flags =
      (display.daylight ? FLAG_DAYLIGHT : 0) | (display.graticule ? FLAG_GRATICULE : 0);
    uniforms.projection.nightFloor = display.nightFloor;
    uniforms.projection.surfaceNightFloor = display.surfaceNightFloor;
    uniforms.projection.terminatorWidth = display.terminatorWidth;
  }

  /** Returns endpoint vertex ids for focus underlays, or [-1, -1] when invalid. */
  function edgeEndpoints(edgeIndex: number): [number, number] {
    const edge = topology?.edges;
    if (!edge || edgeIndex < 0) return [-1, -1];
    const a = edge[edgeIndex * 2];
    const b = edge[edgeIndex * 2 + 1];
    return a === undefined || b === undefined ? [-1, -1] : [a, b];
  }

  /** Updates projection-specific height amplitude from current viewport state. */
  function updateHeightWorldScale(frameVp: Viewport): void {
    if (!topology || !topologyBounds) return;
    uniforms.geometry.heightWorldScale =
      rig.mode === 'globe'
        ? VISUAL.globeHeightRadialScale
        : planeHeightWorldScale(topologyBounds, frameVp, vertexSize);
  }

  /** Computes projection support for the currently loaded topology shape. */
  function projectionAvailability(
    bounds: Bounds | null,
    characteristicLength: number | null,
  ): Network['projections'] {
    const availability = {} as Record<ProjectionMode, boolean>;
    for (const mode of PROJECTION_MODES) {
      availability[mode] = PROJECTIONS[mode].canUse(bounds, characteristicLength);
    }
    return Object.freeze(availability);
  }

  /** Channels whose values alter projected hit geometry rather than color only. */
  function channelAffectsPicking(channel: Channel): boolean {
    return CHANNEL_DEFINITIONS.find((definition) => definition.key === channel)!.map !== 'colormap';
  }

  /** Applies hover focus and stages a notification only when focus state changes. */
  function applyHover(hit: PickResult | null): boolean {
    const changed = hit ? focus.setHover(hit[0], hit[1]) : focus.setHover(null);
    if (!changed) return false;
    pendingHoverNotice = {
      value: hit ? [hit[0], hit[1]] : [null, null],
      scene: sceneGeneration,
    };
    return true;
  }

  /**
   * Re-picks the stored physical pointer against a stable submitted camera pose.
   *
   * Large-scene picking is entirely suppressed during navigation, camera chase,
   * and resize quantization. The first settled frame resolves exactly once and
   * includes the result in that same GPU submission.
   */
  function resolveHover(sizeSettled: boolean): void {
    if (!topology || !hoverProbe || navigationActive) {
      applyHover(null);
      return;
    }
    if (!sizeSettled || rig.camera.isAnimating()) {
      hoverDirty = true;
      applyHover(null);
      return;
    }
    if (!hoverDirty) return;

    let hit: PickResult | null = null;
    {
      const rect = surface.rect();
      const sx = hoverProbe.clientX - rect.left;
      const sy = hoverProbe.clientY - rect.top;
      if (sx >= 0 && sy >= 0 && sx < rect.width && sy < rect.height) {
        hit = picker.pick(
          pickQueryAt(sx, sy, hoverProbe.targetPx, { w: rect.width, h: rect.height }),
        );
      }
    }
    hoverDirty = false;
    applyHover(hit);
  }

  /** Applies programmatic selection without emitting a select event. */
  function applySelection(kind: 'vertex' | 'edge' | null, index = -1): void {
    if (focus.select(kind, index)) repaint();
  }

  /** Applies a user selection and emits the public select event. */
  function commitUserSelection(hit: PickResult | null): void {
    if (hit) {
      applySelection(hit[0], hit[1]);
      events.emit('select', hit[0], hit[1]);
    } else {
      applySelection(null);
      events.emit('select', null, null);
    }
  }

  /** Cycles through stacked hits under a tap, preserving current selection order. */
  function cycleSelection(hits: PickResult[]): void {
    if (hits.length === 0) {
      commitUserSelection(null);
      return;
    }
    const selV = focus.selectedVertex;
    const selE = focus.selectedEdge;
    const index =
      selV >= 0
        ? hits.findIndex((hit) => hit[0] === 'vertex' && hit[1] === selV)
        : selE >= 0
          ? hits.findIndex((hit) => hit[0] === 'edge' && hit[1] === selE)
          : -1;
    commitUserSelection(index < 0 ? hits[0]! : hits[(index + 1) % hits.length]!);
  }

  /**
   * Encodes and binds topology transactionally before mutating controller state.
   *
   * If validation or GPU allocation throws, the previous view remains intact and
   * the descriptive error propagates to the caller.
   */
  function loadTopology(next: Topology): void {
    const encoded = encodeTopology(next);
    const encodedSegments = encodeSegments(next);
    const info = readEncodedTopologyInfo(encoded);
    renderer.bindTopology(encoded, encodedSegments);
    picker.setScene(encoded, encodedSegments);

    topology = next;
    sceneGeneration++;
    pendingHoverNotice = undefined;
    readyHoverNotice = undefined;
    pendingZoomNotice = undefined;
    readyZoomNotice = undefined;
    topologyBounds = info.bounds;
    topologyCharacteristicLength = info.characteristicLength;
    projections = projectionAvailability(topologyBounds, topologyCharacteristicLength);

    hoverDirty = true;
    applyHover(null);
    applySelection(null);

    // A new topology can invalidate the active projection (notably globe).
    // Fall back atomically so the camera, picker mode, and pipelines agree.
    if (!projections[rig.mode]) {
      rig.switchTo('flat', topologyBounds, vp());
      loop.setCamera(rig.camera);
      renderer.useProjectionPipelines('flat');
    }

    vertexSize = info.characteristicLength * VISUAL.vertexSizeScale;
    uniforms.geometry.vertexSize = vertexSize;
    uniforms.geometry.baseEdgeWidth = info.characteristicLength * VISUAL.baseEdgeWidthScale;
    updateHeightWorldScale(vp());

    channels.reset();
    loop.setBounds(info.bounds);
    loop.requestFit();
    loop.frameNow();
  }

  return api;
}
