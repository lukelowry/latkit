/// <reference types="@webgpu/types" />

import type { Item } from '@latkit/model';
import { createPresentation, type Presentation } from '@latkit/gpu';

import { encodeTopology, prepareTopology, type Bounds, type Topology } from './topology/index.js';
import { encodeSegments } from './segments/index.js';
import { prepareScene } from './scene.js';
import { Renderer } from './webgpu/renderer.js';
import {
  createUniforms,
  FLAG_DAYLIGHT,
  FLAG_GEOGRAPHIC,
  FLAG_GRATICULE,
} from './webgpu/uniforms.js';
import { FocusState, type FocusStyle, type RGBA } from './focus-state.js';
import { VISUAL } from './visual.js';
import { CameraRig } from './camera/rig.js';
import { createDaylight, SUN_REFRESH_MS } from './daylight.js';
import { attachPointer, MOUSE_PICK_RADIUS_PX, type HoverProbe } from './input/pointer.js';
import { createSurface } from './input/surface.js';
import { type Pose, MAX_ZOOM_RATIO, type Viewport } from './camera/projection.js';
import { createChannels, type Channel } from './channels.js';
import type { Domain } from './range.js';
import { RenderLoop } from './webgpu/render-loop.js';
import {
  PROJECTION_DEFS,
  PROJECTIONS,
  isGeographicTopology,
  type ProjectionFamily,
  type Projection,
} from './projections.js';
import type { Borders } from './borders/index.js';
import { createEmitter } from './emitter.js';
import { edgeCountOf } from './topology/pack.js';
import { adjacency, neighborhood, type Adjacency } from './topology/adjacency.js';
import { createOrbit } from './orbit.js';
import { Picker, isPickChannel, type PickQuery, type PickResult } from './pick/picker.js';
import {
  DEFAULT_OPTIONS,
  OPTIONS,
  resolveOptions,
  validateOptions,
  type Options,
  type ResolvedOptions,
  type RuntimeOption,
} from './options.js';
import { boundsForItems, expandDegenerateBounds } from './topology/subset-bounds.js';

export type { Options } from './options.js';
export type { Item } from '@latkit/model';

/** Camera behavior for bringing one item into view. */
export interface RevealOptions {
  /** CSS-pixel inset that the item's anchor must clear. @defaultValue `48` */
  readonly paddingPx?: number;
  /** Center the item even when it is already visible inside the inset. @defaultValue `false` */
  readonly center?: boolean;
  /**
   * Frame the item with its neighborhood: an edge with both endpoints, a vertex with its incident
   * edges and their far ends. A lone item is centered at the current scale. @defaultValue `false`
   */
  readonly neighbors?: boolean;
  /** Animate the camera move. @defaultValue `false` */
  readonly animate?: boolean;
}

/**
 * Events emitted by a {@link Network} instance, keyed by name with their payload.
 *
 * @remarks
 * `hover` and `select` carry `null` when interaction state clears. Programmatic
 * selection does not emit `select`; user pointer selection does.
 */
export type Events = {
  /** Hovered vertex or edge, or null after hover exit. */
  hover: Item | null;
  /** User-selected vertex or edge, or null after a clearing tap. */
  select: Item | null;
  /**
   * Browser context request released after right-drag disambiguation.
   *
   * The default action is already prevented. The native event may have been
   * retained until pointer release, so rely on its coordinates, modifiers,
   * and target; `currentTarget` and `composedPath()` are not stable.
   */
  contextmenu: MouseEvent;
  /** Whether the camera sits at the fit view, after a fit transition or gesture. */
  zoom: boolean;
  /** Whether continuous rotation is running, after {@link Network.orbit} or an interrupting gesture. */
  orbit: boolean;
  /** WebGPU device-loss notification surfaced before rendering pauses. */
  deviceLost: { readonly reason: string; readonly message: string };
  /** Asynchronous shader-pipeline build failure; rendering for that family is unavailable. */
  pipelineError: { readonly family: ProjectionFamily; readonly cause: unknown };
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
  /**
   * Active projection: the destination of the last accepted
   * {@link Network.setProjection} call, `'flat'` before any.
   */
  readonly projection: Projection;
  /** Projections currently supported by the loaded topology. */
  readonly projections: Readonly<Record<Projection, boolean>>;
  /**
   * Whether loaded coordinates are interpreted as geographic lon/lat degrees.
   *
   * @remarks
   * True only when the topology supplies its own coordinates, does not
   * declare `coordinateSpace: 'cartesian'`, and its bounds fit longitude and
   * latitude ranges. This interpretation gates daylight shading, geographic
   * ground clipping, and globe availability; generated ring layouts are never
   * geographic. False before the first {@link Network.load}.
   */
  readonly geographic: boolean;
  /** Whether continuous rotation is running. */
  readonly orbiting: boolean;

  /**
   * Subscribe to a network event and receive an unsubscribe callback.
   *
   * @param event - Event name to observe.
   * @param handler - Callback invoked with the event payload.
   * @returns A function that removes the handler.
   */
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;

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
   * @throws Error when the geometry violates the border layout.
   */
  setBorders(borders: Borders | null): void;
  /**
   * Update display options. `msaa` remains construction-only.
   *
   * @param options - Partial display option patch.
   * @throws TypeError or RangeError when any option is invalid; nothing is applied.
   */
  setOptions(options: Options): void;
  /**
   * Bind, replace, or clear a per-vertex or per-edge rendering channel.
   *
   * `domain` configures normalized channels only. Raw `edgeDash`,
   * `vertexVisible`, and `edgeVisible` channels ignore it. A null height
   * domain scans the finite extent of the values.
   *
   * @param channel - Channel name to bind.
   * @param values - Scalar values whose length matches the current topology, or `null` to clear.
   * @param domain - Input domain for normalized channels, or `null` for scanned/default behavior.
   * @throws Error when no topology is loaded or the array length is invalid.
   */
  setChannel(channel: Channel, values: Float32Array | null, domain?: Domain | null): void;
  /**
   * Override the input domain used by a normalized channel.
   *
   * Calls for raw dash and visibility channels are accepted as no-ops.
   *
   * @param channel - Channel name to update.
   * @param domain - Fixed input domain, or `null` to return to the scanned/default domain.
   */
  setChannelDomain(channel: Channel, domain: Domain | null): void;
  /**
   * The input domain a bound normalized channel is using, or null for an unbound or raw channel.
   *
   * @param channel - Channel name to read.
   */
  getChannelDomain(channel: Channel): Domain | null;

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
   * The item plus what touches it in the loaded topology: an edge with both
   * endpoints, a vertex with its incident edges and their far ends.
   *
   * @param item - Vertex or edge identity in the loaded topology.
   * @returns The neighborhood, beginning with `item`; empty before a topology is loaded.
   */
  neighborhood(item: Item): readonly Item[];
  /**
   * Select an item, or clear the selection with `null`, without emitting `select`.
   *
   * @param item - Vertex or edge identity, or `null` to clear.
   */
  select(item: Item | null): void;

  /**
   * Switch projection.
   *
   * @param mode - Projection to activate.
   * @param fallback - When `mode` is unsupported, switch instead to the first
   * supported projection in canonical order.
   * @returns True when the loaded topology supports `mode`.
   */
  setProjection(mode: Projection, fallback?: boolean): boolean;
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
   * Bring an item into view without changing selection, projection, or zoom.
   *
   * Unless `center` is true, an item already visible inside the padded
   * viewport is a no-op. The camera centers valid off-screen or occluded
   * items while retaining the current scale, distance, tilt, and bearing.
   * With `neighbors`, a populated neighborhood is fitted instead. Newer
   * camera commands replace an in-progress reveal.
   *
   * @param item - Vertex or edge identity in the loaded topology.
   * @param options - Visibility inset, centering policy, neighborhood, and animation flag.
   * @returns True for a valid item, including an already-visible no-op.
   */
  reveal(item: Item, options?: RevealOptions): boolean;
  /**
   * Read the camera pose the next {@link Network.setPose} would build on.
   *
   * @returns The current pose, or null before a topology is loaded or the
   * camera is placed.
   */
  getPose(): Pose | null;
  /**
   * Merge a partial camera pose, wrapped and clamped per the active view.
   *
   * With `animate` the camera eases toward the pose; otherwise it is placed
   * immediately. Fields the view cannot host (flat pitch/bearing) clamp to
   * their resting value.
   *
   * @param pose - Pose fields to change; omitted fields keep their value.
   * @param animate - If true, ease toward the pose.
   * @returns True when the pose was accepted and changed camera state.
   */
  setPose(pose: Partial<Pose>, animate?: boolean): boolean;
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
   * Horizontal pixels turn the bearing and vertical pixels tilt the pitch.
   * The call is a no-op in the flat view, which has no rotational freedom.
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
   * Start or stop continuous rotation.
   *
   * A flat view promotes to tilt, a planar view drags horizontally, and a
   * globe drifts longitude. A pointer or wheel gesture on the canvas stops
   * the orbit; `orbit` events report every transition.
   *
   * @param active - Whether rotation should run.
   * @returns True when rotation is running afterwards; false when no 3D projection is available.
   */
  orbit(active: boolean): boolean;

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
  for (const [key, definition] of Object.entries(OPTIONS)) {
    if (definition.live && source[key] !== undefined) target[key] = source[key];
  }
  return patch;
}

/** Internal collaborator seam used by controller behavior tests. */
export interface ControllerDeps {
  createSurface: typeof createSurface;
  createPresentation(device: GPUDevice, canvas: HTMLCanvasElement): Presentation<HTMLCanvasElement>;
  Renderer: typeof Renderer;
  RenderLoop: typeof RenderLoop;
  CameraRig: typeof CameraRig;
  attachPointer: typeof attachPointer;
  Picker: typeof Picker;
  createOrbit: typeof createOrbit;
}

const DEFAULT_CONTROLLER_DEPS: ControllerDeps = {
  createSurface,
  createPresentation,
  Renderer,
  RenderLoop,
  CameraRig,
  attachPointer,
  Picker,
  createOrbit,
};

/** Shared allocation-free result for invalid or empty public queries. */
const NO_ITEMS: readonly Item[] = Object.freeze([]);

/** Default CSS-pixel inset used by reveal visibility checks. */
const DEFAULT_REVEAL_PADDING_PX = 48;

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
  'heightRange',
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
  'heightRange',
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

/** Deliver a latched event payload to a late subscriber with emitter-equivalent error isolation. */
function replay<Payload>(handler: (payload: Payload) => void, payload: Payload): void {
  try {
    handler(payload);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/** Item identity from a pick result. */
function itemOf(hit: PickResult): Item {
  return { kind: hit[0], index: hit[1] };
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

  const presentation = deps.createPresentation(device, canvas);
  lifecycle.add(() => presentation.destroy());
  const uniforms = createUniforms();
  const renderer = new deps.Renderer(presentation, options.msaa);
  lifecycle.add(() => renderer.destroy());
  const daylight = createDaylight(uniforms.light);
  const rig = new deps.CameraRig(uniforms.camera);

  /** First-paint gate for pipeline warming. */
  let hasPainted = false;
  let warmRequested = false;
  let warming = false;

  const loop = new deps.RenderLoop({
    presentation,
    uniforms,
    renderer,
    rig,
    onZoom: (atFitView) => stageZoomNotice(atFitView),
    onBeforeFrame: (frameVp) => {
      daylight.refresh();
      updateHeightWorldScale(frameVp);
    },
    onFrame: (sizeSettled) => resolveHover(sizeSettled),
    onPaint: () => onSuccessfulPaint(),
  });
  lifecycle.add(() => loop.destroy());

  renderer.onPipelinesReady = () => loop.wake();
  let pipelineFailure: Events['pipelineError'] | null = null;
  renderer.onPipelineError = (family, cause) => {
    pipelineFailure = { family, cause };
    events.emit('pipelineError', pipelineFailure);
  };
  /** Schedule a frame for a visual state change. */
  const repaint = (): void => loop.wake();

  let deviceLoss: Events['deviceLost'] | null = null;
  lifecycle.add(
    forwardDeviceLoss(device, (info) => {
      if (deviceLoss) return;
      deviceLoss = {
        reason: info.reason ?? 'unknown',
        message: info.message || 'WebGPU device was lost',
      };
      loop.pause();
      events.emit('deviceLost', deviceLoss);
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
  let topologyAdjacency: Adjacency | null = null;
  let topologyBounds: Bounds | null = null;
  let topologyCharacteristicLength: number | null = null;
  let topologyGeographic = false;
  let projections = projectionAvailability(null, null, false);
  let vertexSize = 0;
  /** Latest physical hover point; converted through the current DOMRect per pick. */
  let hoverProbe: HoverProbe | null = null;
  /** Aggregate pointer/wheel navigation lifecycle supplied by the input adapter. */
  let navigationActive = false;
  /** Invalidates only semantic picks, avoiding repeated large-scene queries. */
  let hoverDirty = false;
  /** Camera state changed: invalidate hover and schedule a frame. */
  const cameraMoved = (): void => {
    hoverDirty = true;
    loop.wake();
  };
  interface VersionedNotice<T> {
    readonly value: T;
    readonly scene: number;
  }
  /** Focus change awaiting a successful frame submission. */
  let pendingHoverNotice: VersionedNotice<Item | null> | undefined;
  /** Latest submitted focus change awaiting post-tick delivery. */
  let readyHoverNotice: VersionedNotice<Item | null> | undefined;
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
    const center = PROJECTION_DEFS[rig.mode].wrapX
      ? ((hasViewport ? rig.camera.screenToWorld(view.w / 2, view.h / 2, view)?.[0] : null) ??
        rig.camera.pose()?.centerX ??
        0)
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
    heightRange: () => display.heightRange,
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

  /** Periodic idle wake while daylight shading is armed for the loaded data. */
  const sunTimer = setInterval(() => {
    if (display.daylight && topologyGeographic) loop.wake();
  }, SUN_REFRESH_MS);
  lifecycle.add(() => clearInterval(sunTimer));

  const pointerCleanup = deps.attachPointer(surface, (intent) => {
    switch (intent.kind) {
      case 'contextmenu':
        events.emit('contextmenu', intent.event);
        break;
      case 'navigationStart':
        orbit.stop();
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
        orbit.stop();
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
        orbit.stop();
        if (!topology) break;
        if (rig.camera.panBy(intent.dx, intent.dy, intent.vp)) loop.wake();
        break;
      case 'zoom':
        orbit.stop();
        if (!topology) break;
        if (rig.camera.zoomAt(intent.factor, intent.sx, intent.sy, intent.vp)) loop.wake();
        break;
      case 'rotate':
        orbit.stop();
        if (!topology) break;
        if (rig.camera.rotateBy(intent.dxPx, intent.dyPx, intent.vp)) loop.wake();
        break;
      case 'tap':
        if (!topology) break;
        cycleSelection(picker.pickAll(pickQueryAt(intent.sx, intent.sy, intent.targetPx)));
        break;
      case 'doubleTap':
        orbit.stop();
        if (!topology || !topologyBounds) break;
        rig.fit(intent.vp, true);
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

  /** Switch projection through the rig and renderer together; false when unsupported. */
  function switchProjection(mode: Projection): boolean {
    if (!projections[mode]) return false;
    if (mode === rig.mode) return true;
    rig.switchTo(mode, vp());
    updateHeightWorldScale(vp());
    renderer.useProjection(mode);
    cameraMoved();
    return true;
  }

  /** Public controller facade; all methods keep state changes behind repaint gates. */
  const api: Network = {
    get projection() {
      return rig.mode;
    },

    get projections() {
      return projections;
    },

    get geographic() {
      return topologyGeographic;
    },

    get orbiting() {
      return orbit.active;
    },

    on(event, handler) {
      const unsubscribe = events.on(event, handler);
      if (event === 'deviceLost' && deviceLoss) {
        replay(handler as (payload: Events['deviceLost']) => void, deviceLoss);
      }
      if (event === 'pipelineError' && pipelineFailure) {
        replay(handler as (payload: Events['pipelineError']) => void, pipelineFailure);
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

    setOptions(options) {
      updateOptions(options);
    },

    setChannel(channel, values, domain) {
      if (values === null) channels.clear(channel);
      else channels.set(channel, values, domain);
      if (isPickChannel(channel)) hoverDirty = true;
      repaint();
    },

    setChannelDomain(channel, domain) {
      channels.setDomain(channel, domain);
      if (isPickChannel(channel)) hoverDirty = true;
      repaint();
    },

    getChannelDomain(channel) {
      return channels.domain(channel);
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
        .map(itemOf);
    },

    locate(item) {
      if (!topology) return null;
      const rect = surface.rect();
      const point = picker.locate([item.kind, item.index], { w: rect.width, h: rect.height });
      return point ? [point[0] + rect.left, point[1] + rect.top] : null;
    },

    neighborhood(item) {
      if (!topology) return NO_ITEMS;
      topologyAdjacency ??= adjacency(topology);
      return neighborhood(topologyAdjacency, item);
    },

    select(item) {
      applySelection(item);
    },

    setProjection(mode, fallback = false) {
      if (switchProjection(mode)) return true;
      if (fallback) for (const candidate of PROJECTIONS) if (switchProjection(candidate)) break;
      return false;
    },

    fit(itemsOrAnimate: readonly Item[] | boolean = false, animate: boolean = false) {
      if (!topology) return;

      if (typeof itemsOrAnimate === 'boolean') {
        rig.fit(vp(), itemsOrAnimate);
      } else {
        if (!topologyBounds) return;
        const { view, bounds } = resolveItemBounds(itemsOrAnimate);
        if (!bounds) return;
        rig.moveTo(expandDegenerateBounds(bounds, topologyBounds, MAX_ZOOM_RATIO), view, animate);
      }
      cameraMoved();
    },

    reveal(item, options = {}) {
      if (!topology || !topologyBounds) return false;
      const animate = options.animate ?? false;
      if (options.neighbors) {
        const items = api.neighborhood(item);
        if (items.length > 1) {
          const { view, bounds } = resolveItemBounds(items);
          if (!bounds) return false;
          rig.moveTo(expandDegenerateBounds(bounds, topologyBounds, MAX_ZOOM_RATIO), view, animate);
          cameraMoved();
          return true;
        }
        return api.reveal(item, { ...options, neighbors: false, center: true });
      }

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
          if (rig.claim()) cameraMoved();
          return true;
        }
      }

      rig.reveal(bounds, view, animate);
      cameraMoved();
      return true;
    },

    getPose() {
      if (!topology) return null;
      return rig.camera.pose();
    },

    setPose(pose, animate = false) {
      if (!topology) return false;
      if (!rig.camera.setPose(pose, animate)) return false;
      cameraMoved();
      return true;
    },

    panBy(dx, dy) {
      if (!topology) return;
      if (!rig.camera.panBy(dx, dy, vp())) return;
      cameraMoved();
    },

    rotateBy(dx, dy) {
      if (!topology) return;
      if (!rig.camera.rotateBy(dx, dy, vp())) return;
      cameraMoved();
    },

    zoomBy(factor) {
      if (!topology) return;
      const v = vp();
      if (!rig.camera.zoomAt(factor, v.w / 2, v.h / 2, v)) return;
      cameraMoved();
    },

    orbit(active) {
      if (!active) {
        orbit.stop();
        return false;
      }
      if (!topology) return false;
      return orbit.start();
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
      orbit.stop();
      pendingHoverNotice = undefined;
      readyHoverNotice = undefined;
      pendingZoomNotice = undefined;
      readyZoomNotice = undefined;
      topology = null;
      topologyAdjacency = null;
      topologyBounds = null;
      topologyCharacteristicLength = null;
      rig.setBounds(null);
      picker.commitScene(null);
      channels.reset();
      lifecycle.destroy();
    },
  };

  const orbit = deps.createOrbit(api, (active) => {
    if (!destroyed) events.emit('orbit', active);
  });

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
          for (const mode of PROJECTIONS) {
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

  /**
   * Promotes submitted public state transitions for delivery after the render tick.
   *
   * Keeping host callbacks out of `onFrame` prevents reentrant load/projection
   * mutations from mixing two scenes into one GPU submission.
   */
  function onSuccessfulPaint(): void {
    if (!hasPainted) {
      hasPainted = true;
      warmInactiveProjections();
    }
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
      if (hoverNotice?.scene === sceneGeneration) events.emit('hover', hoverNotice.value);
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
      (display as Record<DisplayOption, DisplayState[DisplayOption]>)[key] =
        key === 'heightRange' ? [...(value as Domain)] : value;
      if (PICK_GEOMETRY_OPTIONS.has(key)) pickGeometryChanged = true;
    }
    if (opts.dashPeriodPx !== undefined) channels.refreshDashPeriod();
    if (opts.heightRange !== undefined) channels.refreshHeightRange();
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
    // Daylight interprets coordinates as lon/lat degrees, so it arms only for
    // geographic topologies; every projection family shades when it is set.
    // FLAG_GEOGRAPHIC tracks the topology alone: the plane background clips
    // its ground to the lon/lat world rect whenever coordinates are degrees.
    uniforms.light.flags =
      (display.daylight && topologyGeographic ? FLAG_DAYLIGHT : 0) |
      (display.graticule ? FLAG_GRATICULE : 0) |
      (topologyGeographic ? FLAG_GEOGRAPHIC : 0);
    uniforms.light.nightFloor = display.nightFloor;
    uniforms.light.surfaceNightFloor = display.surfaceNightFloor;
    uniforms.light.terminatorWidth = display.terminatorWidth;
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
    const scale = PROJECTION_DEFS[rig.mode].heightWorldScale(
      topologyBounds,
      frameVp,
      vertexSize * display.vertexScale,
    );
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
    geographic: boolean,
  ): Network['projections'] {
    const availability = {} as Record<Projection, boolean>;
    for (const mode of PROJECTIONS) {
      availability[mode] = PROJECTION_DEFS[mode].canUse(bounds, characteristicLength, geographic);
    }
    return Object.freeze(availability);
  }

  /** Applies hover focus and stages a notification only when focus state changes. */
  function applyHover(hit: PickResult | null): boolean {
    const changed = hit ? focus.setHover(hit[0], hit[1]) : focus.setHover(null);
    if (!changed) return false;
    pendingHoverNotice = { value: hit ? itemOf(hit) : null, scene: sceneGeneration };
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
  function applySelection(item: Item | null): void {
    const changed = item ? focus.select(item.kind, item.index) : focus.select(null);
    if (changed) repaint();
  }

  /** Applies a user selection and emits the public select event. */
  function commitUserSelection(hit: PickResult | null): void {
    const item = hit ? itemOf(hit) : null;
    applySelection(item);
    events.emit('select', item);
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
    topologyAdjacency = null;
    sceneGeneration++;
    pendingHoverNotice = undefined;
    readyHoverNotice = undefined;
    pendingZoomNotice = undefined;
    readyZoomNotice = undefined;
    topologyBounds = info.bounds;
    topologyCharacteristicLength = info.characteristicLength;
    // Geographic interpretation requires the caller's own coordinates: the
    // generated ring fallback must never read as lon/lat degrees.
    topologyGeographic = isGeographicTopology(next, info.bounds);
    projections = projectionAvailability(
      topologyBounds,
      topologyCharacteristicLength,
      topologyGeographic,
    );

    hoverDirty = true;
    applyHover(null);
    applySelection(null);

    // A new topology can invalidate the active projection (notably globe).
    // Fall back atomically so the camera, picker mode, and pipelines agree.
    if (!projections[rig.mode]) {
      orbit.stop();
      rig.switchTo('flat', vp());
      renderer.useProjection('flat');
    }

    vertexSize = info.characteristicLength * VISUAL.vertexSizeScale;
    writeGeometryScales(vp());
    // New bounds can change the geographic daylight gate.
    writeDisplayToUniforms();

    channels.reset();
    // A fresh scene schedules its canonical fit on the rig.
    rig.setBounds(topologyBounds);
    warmInactiveProjections();
    loop.frameNow();
  }

  return api;
}
