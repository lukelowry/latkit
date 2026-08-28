/// <reference types="@webgpu/types" />

import { createPresentation, type Presentation } from '@latkit/gpu';

import { encodeTopology, prepareTopology, type Bounds, type Topology } from './topology/index.js';
import { encodeSegments } from './segments/index.js';
import { prepareScene } from './scene.js';
import { Renderer } from './webgpu/renderer.js';
import { createUniforms, FLAG_DAYLIGHT, FLAG_GRATICULE } from './webgpu/uniforms.js';
import { FocusState, type FocusStyle, type RGBA } from './focus-state.js';
import { VISUAL, planeHeightWorldScale } from './visual.js';
import { ProjectionRig } from './camera/rig.js';
import { attachPointer, MOUSE_PICK_RADIUS_PX, type HoverProbe } from './input/pointer.js';
import { createSurface } from './input/surface.js';
import { MAX_ZOOM_RATIO, type Viewport } from './camera/projection.js';
import { createChannels, type Channel } from './channels.js';
import type { ChannelRange } from './range.js';
import { RenderLoop } from './webgpu/render-loop.js';
import {
  PROJECTIONS,
  PROJECTION_MODES,
  type PipelineMode,
  type ProjectionMode,
} from './projections.js';
import type { Borders } from './borders.js';
import { createEmitter } from './emitter.js';
import { edgeCountOf } from './topology/pack.js';
import { Picker, isPickChannel, type PickQuery, type PickResult } from './pick/picker.js';
import {
  DEFAULT_OPTIONS,
  OPTION_DEFINITIONS,
  resolveOptions,
  validateOptions,
  type Options,
  type ResolvedOptions,
  type RuntimeOption,
} from './options.js';
import { boundsForItems, expandDegenerateBounds } from './topology/subset-bounds.js';

export type { Options } from './options.js';

/** Identity of one vertex or edge in the loaded topology. */
export interface Item {
  /** Topology primitive kind. */
  readonly kind: 'vertex' | 'edge';
  /** Zero-based vertex or edge index. */
  readonly index: number;
}

/** Camera behavior for bringing one item into view without reframing it. */
export interface RevealOptions {
  /** CSS-pixel inset that the item's anchor must clear. @defaultValue `48` */
  readonly paddingPx?: number;
  /** Center the item even when it is already visible inside the inset. @defaultValue `false` */
  readonly center?: boolean;
  /** Animate the camera move. @defaultValue `false` */
  readonly animate?: boolean;
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
  /**
   * Browser context request released after right-drag disambiguation.
   *
   * The default action is already prevented. The native event may have been
   * retained until pointer release, so rely on its coordinates, modifiers,
   * and target; `currentTarget` and `composedPath()` are not stable.
   */
  contextmenu: (event: MouseEvent) => void;
  /** Camera zoom state after a fit-view transition or gesture. */
  zoom: (atFitView: boolean) => void;
  /** WebGPU device-loss notification surfaced before rendering pauses. */
  deviceLost: (reason: string, message: string) => void;
  /** Asynchronous shader-pipeline build failure; rendering for that family is unavailable. */
  pipelineError: (pipeline: PipelineMode, cause: unknown) => void;
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
   * Query visible geometry at a client-space point without changing focus.
   *
   * Returns at most two items: the best vertex followed by the best edge.
   * The default radius is 10 CSS pixels; callers handling touch input should
   * pass an appropriate larger radius. The radius is clamped to the viewport
   * diagonal to keep pathological requests bounded.
   *
   * @param clientX - Client-space horizontal coordinate in CSS pixels.
   * @param clientY - Client-space vertical coordinate in CSS pixels.
   * @param radiusPx - Optional search radius in CSS pixels.
   * @returns Matching visible items in pick priority order.
   */
  hitTest(clientX: number, clientY: number, radiusPx?: number): readonly Item[];
  /**
   * Project an item to a client-space CSS-pixel anchor without changing focus.
   *
   * The coordinate may be outside the canvas or visually occluded. Display
   * visibility options do not affect the result.
   *
   * @param item - Vertex or edge identity in the loaded topology.
   * @returns The projected client coordinate, or null for an invalid or unprojectable item.
   */
  locate(item: Item): readonly [clientX: number, clientY: number] | null;
  /**
   * Bring an item into view without changing selection, projection, or zoom.
   *
   * Unless `center` is true, an item already visible inside the padded
   * viewport is a no-op. The camera centers valid off-screen or occluded
   * items while retaining the current scale, distance, tilt, and bearing.
   * Newer camera commands replace an in-progress reveal.
   *
   * @param item - Vertex or edge identity in the loaded topology.
   * @param options - Visibility inset, centering policy, and animation flag.
   * @returns True for a valid item, including an already-visible no-op.
   */
  reveal(item: Item, options?: RevealOptions): boolean;
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
   * `domain` configures normalized channels only. Raw `edgeDash`,
   * `vertexVisible`, and `edgeVisible` channels ignore both range arguments.
   * Height channels may pass an output `range`; a null height domain retains
   * automatic finite-extent scanning.
   *
   * @param channel - Channel name to bind.
   * @param values - Scalar values whose length matches the current topology.
   * @param domain - Input domain for normalized channels, or `null` for scanned/default behavior.
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
   * Override the input domain used by a normalized channel.
   *
   * Calls for raw dash and visibility channels are accepted as no-ops.
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
   * Fit valid items into the current viewport without changing selection.
   *
   * Invalid or stale items are ignored; an empty valid subset is a no-op.
   * Base topology geometry is framed independently of display visibility and
   * transient channel displacement. A valid request made before camera
   * placement is deferred until the first non-empty viewport frame.
   *
   * @param items - Vertex and edge identities to frame.
   * @param animate - If true, animate toward the subset view.
   */
  fit(items: readonly Item[], animate?: boolean): void;
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
   * Rotate the active camera by screen pixels.
   *
   * The call is a no-op when the active projection does not support rotation.
   *
   * @param dx - Horizontal delta in CSS pixels.
   * @param dy - Vertical delta in CSS pixels.
   */
  rotateBy(dx: number, dy: number): void;
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

/** Shared allocation-free result for invalid or empty public hit tests. */
const NO_ITEMS: readonly Item[] = Object.freeze([]);

/** Default CSS-pixel inset used by reveal visibility checks. */
const DEFAULT_REVEAL_PADDING_PX = 48;

/** Default opacity transition length used by {@link Network.fadeIn}. */
const FADE_IN_MS = 150;

/** Wake cadence for globe daylight updates while the globe is visible. */
const SUN_REFRESH_MS = 30_000;

/** Runtime options mirrored one-to-one into controller display state. */
const DISPLAY_OPTIONS = [
  'daylight',
  'graticule',
  'borders',
  'vertices',
  'edges',
  'poles',
  'vertexScale',
  'edgeScale',
  'heightScale',
  'vertexLodPx',
  'dashPeriodPx',
  'earthAxis',
  'nightFloor',
  'surfaceNightFloor',
  'terminatorWidth',
] as const satisfies readonly RuntimeOption[];

type DisplayOption = (typeof DISPLAY_OPTIONS)[number];

/** Mutable display state; every key is a resolved runtime option. */
type DisplayState = { -readonly [Key in DisplayOption]: ResolvedOptions[Key] };

/** Display options whose change moves, resizes, or hides pickable geometry. */
const PICK_GEOMETRY_OPTIONS: ReadonlySet<DisplayOption> = new Set<DisplayOption>([
  'vertices',
  'edges',
  'poles',
  'vertexScale',
  'edgeScale',
  'heightScale',
  'vertexLodPx',
  'dashPeriodPx',
]);

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

/** Deliver latched event arguments to a late subscriber with emitter-equivalent error isolation. */
function replay<Args extends unknown[]>(handler: (...args: Args) => void, args: Args): void {
  try {
    handler(...args);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
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
  let warmRequested = false;
  let warming = false;

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
  let pipelineFailure: Parameters<Events['pipelineError']> | null = null;
  renderer.onProjectionPipelinesError = (pipeline, cause) => {
    pipelineFailure = [pipeline, cause];
    events.emit('pipelineError', pipeline, cause);
  };
  /** Schedule a frame for a visual state change. */
  const repaint = (): void => loop.wake();

  const rig = new deps.ProjectionRig(uniforms.projection);
  loop.setCamera(rig.camera);

  let deviceLoss: Parameters<Events['deviceLost']> | null = null;
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
  const display = Object.fromEntries(
    DISPLAY_OPTIONS.map((key) => [key, DEFAULT_OPTIONS[key]]),
  ) as DisplayState;

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

  /** Resolve viewport state and projection-aware bounds for item camera commands. */
  const resolveItemBounds = (items: readonly Item[]) => {
    const view = vp();
    const hasViewport =
      Number.isFinite(view.w) && Number.isFinite(view.h) && view.w > 0 && view.h > 0;
    const center =
      rig.mode === 'globe'
        ? ((hasViewport ? rig.camera.screenToWorld(view.w / 2, view.h / 2, view)?.[0] : null) ??
          rig.camera.current[0]!)
        : null;
    return {
      view,
      hasViewport,
      bounds: topology ? boundsForItems(topology, items, center) : null,
    };
  };

  /** Normalize reveal padding and retain a usable central viewport band. */
  const resolveRevealPadding = (paddingPx: number | undefined, view: Viewport): number => {
    const requested =
      paddingPx === undefined || !Number.isFinite(paddingPx) || paddingPx < 0
        ? DEFAULT_REVEAL_PADDING_PX
        : paddingPx;
    const maximum = Math.max(0, (Math.min(view.w, view.h) - 2) / 2);
    return Math.min(requested, maximum);
  };

  const channels = createChannels(uniforms, renderer, {
    loaded: () => topology !== null,
    vertexCount: () => topology?.vertexCount ?? 0,
    edgeCount: () => (topology ? edgeCountOf(topology) : 0),
    dashPeriodPx: () => display.dashPeriodPx,
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
  applyOptions(options, true);

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
      case 'contextmenu':
        events.emit('contextmenu', intent.event);
        break;
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
        if (!topology || !topologyBounds) break;
        loop.cancelPlacement();
        rig.camera.fitView(topologyBounds, intent.vp);
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
      if (event === 'deviceLost' && deviceLoss) replay(handler as Events['deviceLost'], deviceLoss);
      if (event === 'pipelineError' && pipelineFailure) {
        replay(handler as Events['pipelineError'], pipelineFailure);
      }
      return unsubscribe;
    },

    hitTest(clientX, clientY, radiusPx = MOUSE_PICK_RADIUS_PX) {
      if (
        !topology ||
        !Number.isFinite(clientX) ||
        !Number.isFinite(clientY) ||
        !Number.isFinite(radiusPx) ||
        radiusPx < 0
      ) {
        return NO_ITEMS;
      }

      const rect = surface.rect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        sx < 0 ||
        sy < 0 ||
        sx >= rect.width ||
        sy >= rect.height
      ) {
        return NO_ITEMS;
      }

      const boundedRadius = Math.min(radiusPx, Math.hypot(rect.width, rect.height));
      return picker
        .pickAll(pickQueryAt(sx, sy, boundedRadius, { w: rect.width, h: rect.height }))
        .map(([kind, index]) => ({ kind, index }));
    },

    locate(item) {
      if (!topology) return null;
      const rect = surface.rect();
      const point = picker.locate([item.kind, item.index], { w: rect.width, h: rect.height });
      return point ? [point[0] + rect.left, point[1] + rect.top] : null;
    },

    reveal(item, options = {}) {
      if (!topology || !topologyBounds) return false;
      const { view, hasViewport, bounds } = resolveItemBounds([item]);
      if (!bounds) return false;

      if (hasViewport && !options.center) {
        const location = picker.locateDetail([item.kind, item.index], view);
        const padding = resolveRevealPadding(options.paddingPx, view);
        if (
          location?.visible &&
          location.point[0] >= padding &&
          location.point[0] <= view.w - padding &&
          location.point[1] >= padding &&
          location.point[1] <= view.h - padding
        ) {
          const claimed = rig.camera.claimCurrent();
          if (claimed) {
            loop.cancelPlacement();
            hoverDirty = true;
            loop.wake();
          } else {
            loop.cancelDeferredMove();
          }
          return true;
        }
      }

      const animate = options.animate ?? false;
      if (!hasViewport) {
        // Zero-size initial placement already retains needsFit; established
        // cameras must keep their current zoom when the viewport returns.
        loop.requestReveal(bounds, animate);
        hoverDirty = true;
        loop.wake();
        return true;
      }

      const result = rig.camera.reveal(bounds, view, animate);
      if (result === 'unavailable') {
        loop.requestFit();
        loop.requestReveal(bounds, animate);
      } else if (result === 'unchanged') {
        loop.cancelDeferredMove();
        return true;
      } else {
        loop.cancelPlacement();
      }
      hoverDirty = true;
      loop.wake();
      return true;
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
      if (isPickChannel(channel)) hoverDirty = true;
      repaint();
    },

    clearChannel(channel) {
      channels.clear(channel);
      if (isPickChannel(channel)) hoverDirty = true;
      repaint();
    },

    setChannelRange(channel, range) {
      channels.setRange(channel, range);
      if (isPickChannel(channel)) hoverDirty = true;
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
      loop.cancelPlacement();
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

    fit(itemsOrAnimate: readonly Item[] | boolean = false, animate: boolean = false) {
      if (!topology) return;

      if (typeof itemsOrAnimate === 'boolean') {
        const view = vp();
        if (itemsOrAnimate && view.w > 0 && view.h > 0 && topologyBounds) {
          loop.cancelPlacement();
          rig.camera.fitView(topologyBounds, view);
        } else {
          loop.requestFit();
        }
      } else {
        if (!topologyBounds) return;
        const { view, hasViewport, bounds } = resolveItemBounds(itemsOrAnimate);
        if (!bounds) return;
        const framed = expandDegenerateBounds(bounds, topologyBounds, MAX_ZOOM_RATIO);
        if (!hasViewport || !rig.camera.moveTo(framed, view, animate)) {
          loop.requestFit();
          loop.requestMove(framed, animate);
        } else {
          loop.cancelPlacement();
        }
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

    rotateBy(dx, dy) {
      if (!topology) return;
      if (!rig.camera.rotateBy(dx, dy, vp())) return;
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
      picker.commitScene(null);
      channels.reset();
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

  /** Warms currently supported inactive projections in serial build order. */
  function warmInactiveProjections(): void {
    if (!hasPainted || destroyed) return;
    warmRequested = true;
    if (warming) return;
    warming = true;

    void (async () => {
      try {
        while (warmRequested && !destroyed) {
          warmRequested = false;
          for (const mode of PROJECTION_MODES) {
            if (mode !== rig.mode && projections[mode]) {
              try {
                await renderer.warmProjection(mode);
              } catch (error) {
                console.error(`network: failed to warm the ${mode} projection pipelines`, error);
              }
            }
            if (destroyed) return;
          }
        }
      } finally {
        warming = false;
        if (warmRequested) warmInactiveProjections();
      }
    })();
  }

  /** Flushes a pending fade-in request exactly once after the first paint. */
  function onFirstPaint(): void {
    if (hasPainted) return;
    hasPainted = true;
    if (pendingFadeMs !== null) {
      revealCanvas(pendingFadeMs);
      pendingFadeMs = null;
    }
    warmInactiveProjections();
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
    if (colormapLut) renderer.writeColormap(colormapLut);
    if (opts.baseColor) applyBaseColor(opts.baseColor);
    if (opts.graticuleColor) uniforms.gridColor.set(opts.graticuleColor);
    if (opts.surfaceColor) uniforms.surfaceColor.set(opts.surfaceColor);
    if (opts.borderColor) uniforms.borderColor.set(opts.borderColor);
    let pickGeometryChanged = false;
    for (const key of DISPLAY_OPTIONS) {
      const value = opts[key];
      if (value === undefined || value === display[key]) continue;
      (display as Record<DisplayOption, boolean | number>)[key] = value;
      if (PICK_GEOMETRY_OPTIONS.has(key)) pickGeometryChanged = true;
    }
    if (opts.dashPeriodPx !== undefined) channels.refreshDashPeriod();
    applyFocusOptions(opts);
    renderer.setVisible({
      vertices: display.vertices,
      edges: display.edges,
      poles: display.poles,
      borders: display.borders,
      earthAxis: display.earthAxis,
    });
    writeDisplayToUniforms();
    writeGeometryScales(vp());
    return pickGeometryChanged;
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

  /** Writes display flags, lighting scalars, and screen-space thresholds into uniforms. */
  function writeDisplayToUniforms(): void {
    uniforms.projection.flags =
      (display.daylight ? FLAG_DAYLIGHT : 0) | (display.graticule ? FLAG_GRATICULE : 0);
    uniforms.projection.nightFloor = display.nightFloor;
    uniforms.projection.surfaceNightFloor = display.surfaceNightFloor;
    uniforms.projection.terminatorWidth = display.terminatorWidth;
    uniforms.geometry.vertexLod = display.vertexLodPx;
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
    const scale =
      rig.mode === 'globe'
        ? VISUAL.globeHeightRadialScale
        : planeHeightWorldScale(topologyBounds, frameVp, vertexSize * display.vertexScale);
    uniforms.geometry.heightWorldScale = scale * display.heightScale;
  }

  /** Writes topology-derived geometry sizes through the current display multipliers. */
  function writeGeometryScales(frameVp: Viewport): void {
    if (topologyCharacteristicLength === null) return;
    uniforms.geometry.vertexSize = vertexSize * display.vertexScale;
    uniforms.geometry.baseEdgeWidth =
      topologyCharacteristicLength * VISUAL.baseEdgeWidthScale * display.edgeScale;
    updateHeightWorldScale(frameVp);
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
    const prepared = prepareTopology(next);
    const encoded = encodeTopology(prepared);
    const encodedSegments = encodeSegments(prepared);
    const scene = prepareScene(encoded, encodedSegments);
    const pickScene = picker.prepareScene(scene);
    renderer.bindTopology(scene);
    picker.commitScene(pickScene);

    const info = scene.info;
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
    writeGeometryScales(vp());

    channels.reset();
    loop.setBounds(topologyBounds);
    loop.requestFit();
    warmInactiveProjections();
    loop.frameNow();
  }

  return api;
}
