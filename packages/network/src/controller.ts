/// <reference types="@webgpu/types" />

import {
  encodeTopology,
  readEncodedTopologyInfo,
  type Bounds,
  type Topology,
} from './topology/index.js';
import { encodeSegments } from './segments/index.js';
import { Renderer } from './webgpu/renderer.js';
import { createGpuContext, destroyGpuContext, type GpuContext } from './webgpu/context.js';
import {
  createUniforms,
  FLAG_DAYLIGHT,
  FLAG_GRATICULE,
  type ProjectionRegion,
} from './webgpu/uniforms.js';
import { FocusState, type FocusStyle, type RGBA } from './focus-state.js';
import { VISUAL, planeHeightWorldScale } from './visual.js';
import { ProjectionRig } from './camera/rig.js';
import { attachPointer, type HoverProbe } from './input/pointer.js';
import { createSurface } from './input/surface.js';
import type { Viewport } from './camera/projection.js';
import { createChannels, type Channel } from './channels.js';
import { RenderLoop, type RenderLoopDeps } from './webgpu/render-loop.js';
import { PROJECTIONS, type ProjectionMode } from './projections.js';
import type { Borders } from './borders.js';
import { createEmitter } from './emitter.js';
import { edgeCountOf } from './topology/pack.js';
import { Picker, type PickerDeps, type PickQuery, type PickResult } from './pick/picker.js';

/**
 * Initial network renderer configuration.
 *
 * @remarks
 * `msaa` is read once at construction. Other fields seed the initial view and
 * can be patched later with {@link Network.setOptions}.
 */
export interface Options {
  /**
   * Multisample anti-aliasing sample count selected at construction.
   *
   * @defaultValue Automatically selects `4` on typical displays and `1` on very large device-pixel surfaces.
   */
  msaa?: 1 | 4;
  /**
   * Draw vertex billboards.
   *
   * @defaultValue `true`.
   */
  vertices?: boolean;
  /**
   * Draw edge segments.
   *
   * @defaultValue `true`.
   */
  edges?: boolean;
  /**
   * Draw height poles when a `vertexHeight` channel is active.
   *
   * @defaultValue `false`.
   */
  poles?: boolean;
  /**
   * Draw geographic border overlays.
   *
   * @defaultValue `true`.
   */
  borders?: boolean;
  /**
   * Draw projection graticule lines.
   *
   * @defaultValue `false`.
   */
  graticule?: boolean;
  /**
   * Draw the globe earth-axis indicator when supported.
   *
   * @defaultValue `true`.
   */
  earthAxis?: boolean;
  /**
   * Enable time-based daylight shading.
   *
   * @defaultValue `true`.
   */
  daylight?: boolean;
  /**
   * Minimum brightness on the night side of overlay geometry.
   *
   * @defaultValue `0.55`.
   */
  nightFloor?: number;
  /**
   * Minimum brightness on the night side of opaque surfaces.
   *
   * @defaultValue `0.1`.
   */
  surfaceNightFloor?: number;
  /**
   * Softness of the day/night terminator in shader units.
   *
   * @defaultValue `0.12`.
   */
  terminatorWidth?: number;
  /**
   * Resting vertex color when the `vertexColor` channel carries no signal.
   *
   * @defaultValue `[0.5, 0.5, 0.5, 1]`.
   */
  baseColor?: readonly [number, number, number, number];
  /**
   * Seeds the color lookup texture used by colormap channels.
   *
   * @defaultValue A neutral gray ramp.
   */
  colormap?: (t: number) => readonly [number, number, number];
  /**
   * Graticule line color as four normalized color channels.
   *
   * @defaultValue `[0.45, 0.48, 0.54, 1]`.
   */
  graticuleColor?: readonly [number, number, number, number];
  /**
   * Tilt ground plane and globe sphere base color as four normalized color channels.
   *
   * @defaultValue `[0.15, 0.16, 0.19, 1]`.
   */
  surfaceColor?: readonly [number, number, number, number];
  /**
   * Geographic border tint as four normalized color channels; shaders keep tier alpha.
   *
   * @defaultValue `[0.52, 0.5, 0.49, 1]`.
   */
  borderColor?: readonly [number, number, number, number];
  /**
   * Enable hover and selection highlighting.
   *
   * @defaultValue `true`.
   */
  focusEnabled?: boolean;
  /**
   * Hover highlight color as four normalized color channels.
   *
   * @defaultValue `[0.72, 0.28, 0.18, 1]`.
   */
  hoverColor?: readonly [number, number, number, number];
  /**
   * Selection highlight color as four normalized color channels.
   *
   * @defaultValue `[0.72, 0.28, 0.18, 1]`.
   */
  selectedColor?: readonly [number, number, number, number];
  /**
   * Multiplier applied to the hover color alpha channel.
   *
   * @defaultValue `0.5`.
   */
  hoverAlpha?: number;
  /**
   * Multiplier applied to the selected color alpha channel.
   *
   * @defaultValue `0.82`.
   */
  selectedAlpha?: number;
  /**
   * Additional hover radius around focused vertices, in device pixels.
   *
   * @defaultValue `6`.
   */
  vertexHoverPx?: number;
  /**
   * Additional selection radius around focused vertices, in device pixels.
   *
   * @defaultValue `7`.
   */
  vertexSelectedPx?: number;
  /**
   * Additional hover half-width around focused edges, in device pixels.
   *
   * @defaultValue `3.5`.
   */
  edgeHoverPx?: number;
  /**
   * Additional selection half-width around focused edges, in device pixels.
   *
   * @defaultValue `5`.
   */
  edgeSelectedPx?: number;
  /**
   * Endpoint highlight mode for focused edges.
   *
   * @defaultValue `"selected"`.
   */
  focusEndpointMode?: 'off' | 'selected' | 'hover-selected';
}

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
 * The controller owns the inserted canvas, pointer handlers, render loop, and
 * GPU resources. Call {@link Network.destroy} when the host removes the view.
 * Load topology before binding channels or reading projection availability.
 */
export interface Network {
  /** Canvas element inserted into the supplied container. */
  readonly element: HTMLCanvasElement;
  /** Projection modes currently supported by the loaded topology. */
  readonly projections: Readonly<{ flat: boolean; tilt: boolean; globe: boolean }>;
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
  setColormap(fn: (t: number) => readonly [number, number, number]): void;
  /**
   * Set the default vertex color used without a `vertexColor` channel.
   *
   * @param color - RGBA color with normalized channels in `[0, 1]`.
   */
  setBaseColor(color: readonly [number, number, number, number]): void;
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
    domain?: readonly [number, number] | null,
    range?: readonly [number, number],
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
  setChannelRange(channel: Channel, range: readonly [number, number] | null): void;
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
  setProjection(mode: 'flat' | 'tilt' | 'globe'): boolean;
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
  /** Release event handlers, GPU resources, and DOM surface state. */
  destroy(): void;
}

/** Internal factory seam used by controller behavior tests. */
export interface ControllerDeps {
  createSurface: typeof createSurface;
  createGpuContext: typeof createGpuContext;
  destroyGpuContext: typeof destroyGpuContext;
  createRenderer(gpu: GpuContext, msaa?: 1 | 4): Renderer;
  createRenderLoop(deps: RenderLoopDeps): RenderLoop;
  createRig(region: ProjectionRegion): ProjectionRig;
  attachPointer: typeof attachPointer;
  createPicker(deps: PickerDeps): Picker;
}

const DEFAULT_CONTROLLER_DEPS: ControllerDeps = {
  createSurface,
  createGpuContext,
  destroyGpuContext,
  /* v8 ignore next -- thin default dependency wrapper; Renderer is unit-tested directly. */
  createRenderer: (gpu, msaa) => new Renderer(gpu, msaa),
  /* v8 ignore next -- thin default dependency wrapper; RenderLoop is unit-tested directly. */
  createRenderLoop: (deps) => new RenderLoop(deps),
  /* v8 ignore next -- thin default dependency wrapper; ProjectionRig is unit-tested directly. */
  createRig: (region) => new ProjectionRig(region),
  attachPointer,
  /* v8 ignore next -- thin default dependency wrapper; Picker is unit-tested directly. */
  createPicker: (deps) => new Picker(deps),
};

/** Screen-space threshold used by shaders for vertex level-of-detail behavior. */
const VERTEX_LOD_PX = 2;

/** Default opacity transition length used by {@link Network.fadeIn}. */
const FADE_IN_MS = 150;

/** Wake cadence for globe daylight updates while the globe is visible. */
const SUN_REFRESH_MS = 30_000;

/** Number of entries in the renderer's one-dimensional colormap texture. */
const COLORMAP_LUT_SIZE = 256;

/** Neutral resting vertex color used before options are applied. */
const DEFAULT_BASE_COLOR: RGBA = [0.5, 0.5, 0.5, 1];

/** Converts a clamped 0..1 color component into an 8-bit LUT value. */
const u8 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 255);

/** Shared default focus accent color. */
const DEFAULT_FOCUS_COLOR: RGBA = [0.72, 0.28, 0.18, 1];

/** Default hover and selection style written into focus uniforms. */
const DEFAULT_FOCUS_STYLE: FocusStyle = {
  enabled: true,
  hoverColor: DEFAULT_FOCUS_COLOR,
  selectedColor: DEFAULT_FOCUS_COLOR,
  hoverAlpha: 0.5,
  selectedAlpha: 0.82,
  vertexHoverPx: 6,
  vertexSelectedPx: 7,
  edgeHoverPx: 3.5,
  edgeSelectedPx: 5,
  endpointMode: 'selected',
};

/**
 * Creates a WebGPU network renderer and appends its canvas to `container`.
 *
 * @param container - Host element that owns the inserted canvas.
 * @param options - Initial rendering and interaction options.
 * @returns A controller for loading topology, binding channels, and releasing GPU resources.
 * @throws Error when WebGPU initialization fails.
 *
 * @example
 * ```ts
 * const network = await createNetwork(container, { graticule: true });
 * network.load(topology);
 * network.fadeIn();
 * ```
 *
 * The returned controller owns the inserted canvas and must be destroyed when
 * the host no longer needs it.
 */
export async function createNetwork(
  container: HTMLElement,
  options: Options = {},
): Promise<Network> {
  return createNetworkWithDeps(container, options, DEFAULT_CONTROLLER_DEPS);
}

/** @internal */
export async function createNetworkWithDeps(
  container: HTMLElement,
  options: Options,
  deps: ControllerDeps,
): Promise<Network> {
  const events = createEmitter<Events>();
  const surface = deps.createSurface(container);
  const canvas = surface.element;
  canvas.style.opacity = '0';
  canvas.setAttribute('aria-hidden', 'true');

  let gpu: GpuContext;
  try {
    gpu = await deps.createGpuContext(canvas);
  } catch (error) {
    surface.destroy();
    events.clear();
    throw error;
  }
  const uniforms = createUniforms();
  const renderer = deps.createRenderer(gpu, options.msaa);

  /**
   * First-paint gate for fadeIn requests.
   *
   * The canvas starts hidden and should become visible only after content has
   * actually painted, so load(); fadeIn() never reveals a blank compiling frame.
   */
  let hasPainted = false;
  let pendingFadeMs: number | null = null;

  const loop = deps.createRenderLoop({
    canvas,
    uniforms,
    renderer,
    onZoom: (atFitView) => stageZoomNotice(atFitView),
    onBeforeFrame: (frameVp) => updateHeightWorldScale(frameVp),
    onFrame: (sizeSettled) => resolveHover(sizeSettled),
    onPaint: () => onSuccessfulPaint(),
  });

  renderer.onProjectionPipelinesReady = () => loop.wake();
  /** Schedule a frame for a visual state change. */
  const repaint = (): void => loop.wake();

  const rig = deps.createRig(uniforms.projection);
  loop.setCamera(rig.camera);

  let deviceLost = false;
  void gpu.device.lost.then((info) => {
    if (deviceLost) return;
    deviceLost = true;
    if (info.reason === 'destroyed') return;
    loop.pause();
    events.emit('deviceLost', info.reason ?? 'unknown', info.message || 'WebGPU device was lost');
  });

  let consumerPaused = false;
  let pageVisible = typeof document !== 'undefined' ? !document.hidden : true;

  /** Keeps loop activity consistent with user pause, page visibility, and device loss. */
  function syncRenderLoopActivity(): void {
    if (!consumerPaused && pageVisible && !deviceLost) loop.resume();
    else loop.pause();
  }

  /** Mirrors document visibility into render-loop activity. */
  const onVisibilityChange = (): void => {
    pageVisible = !document.hidden;
    syncRenderLoopActivity();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  /** Mutable display state mirrored into uniforms and renderer visibility. */
  const display = {
    daylight: true,
    graticule: false,
    borders: true,
    vertices: true,
    edges: true,
    poles: false,
    earthAxis: true,
    nightFloor: 0.55,
    surfaceNightFloor: 0.1,
    terminatorWidth: 0.12,
  };

  uniforms.geometry.vertexLod = VERTEX_LOD_PX;
  let focusStyle = DEFAULT_FOCUS_STYLE;
  const focus = new FocusState(uniforms, edgeEndpoints, focusStyle);
  applyBaseColor(DEFAULT_BASE_COLOR);
  applyOptions(options);

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

  /** Current canvas viewport in device pixels. */
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
  const picker = deps.createPicker({
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

  /** Public controller facade; all methods keep state changes behind repaint gates. */
  const api: Network = {
    get element() {
      return canvas;
    },
    get projections() {
      return projections;
    },

    on: events.on,

    load(next) {
      loadTopology(next);
    },

    setBorders(borders) {
      renderer.setBorders(borders);
      repaint();
    },

    setColormap(fn) {
      applyColormap(fn);
      repaint();
    },

    setBaseColor(color) {
      applyBaseColor(color);
      repaint();
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
      if (applyOptions(options)) hoverDirty = true;
      repaint();
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
      clearInterval(sunTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      loop.destroy();
      topology = null;
      topologyBounds = null;
      topologyCharacteristicLength = null;
      pointerCleanup.destroy();
      renderer.destroy();
      deps.destroyGpuContext(gpu);
      surface.destroy();
      events.clear();
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

  /** Samples a user colormap into the fixed-size GPU LUT texture. */
  function applyColormap(fn: (t: number) => readonly [number, number, number]): void {
    const lut = new Uint8Array(COLORMAP_LUT_SIZE * 4);
    for (let i = 0; i < COLORMAP_LUT_SIZE; i++) {
      const [r, g, b] = fn(i / (COLORMAP_LUT_SIZE - 1));
      lut[i * 4] = u8(r);
      lut[i * 4 + 1] = u8(g);
      lut[i * 4 + 2] = u8(b);
      lut[i * 4 + 3] = 255;
    }
    renderer.writeColormap(lut);
  }

  /** Applies construction or runtime display options. */
  function applyOptions(opts: Options): boolean {
    const pickVisibilityChanged =
      (opts.vertices !== undefined && opts.vertices !== display.vertices) ||
      (opts.edges !== undefined && opts.edges !== display.edges) ||
      (opts.poles !== undefined && opts.poles !== display.poles);
    if (opts.baseColor) applyBaseColor(opts.baseColor);
    if (opts.colormap) applyColormap(opts.colormap);
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
    update('hoverColor', opts.hoverColor);
    update('selectedColor', opts.selectedColor);
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
    for (const def of Object.values(PROJECTIONS)) {
      availability[def.mode] = def.canUse(bounds, characteristicLength);
    }
    return availability as Network['projections'];
  }

  /** Channels whose values alter projected hit geometry rather than color only. */
  function channelAffectsPicking(channel: Channel): boolean {
    return channel === 'vertexHeight' || channel === 'vertexSize' || channel === 'edgeDash';
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
