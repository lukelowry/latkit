/// <reference types="@webgpu/types" />

import { bakeColormap, createEmitter, type Domain, type Item } from '@latkit/model';
import { createPresentation, type DeviceLease, type Presentation } from '@latkit/gpu';

import {
  encodeTopology,
  prepareTopology,
  sameTopology,
  type Bounds,
  type Topology,
} from './topology/index.js';
import { encodeSegments } from './segments/index.js';
import { prepareScene, type PreparedScene } from './scene.js';
import { Renderer } from './webgpu/renderer.js';
import {
  createUniforms,
  DISPLAY_DAYLIGHT,
  DISPLAY_EDGE_BASE_COLOR,
  DISPLAY_GEOGRAPHIC,
  DISPLAY_GRATICULE,
  DISPLAY_VERTICES,
} from './webgpu/uniforms.js';
import { FocusState, type FocusStyle } from './focus-state.js';
import { VISUAL } from './visual.js';
import { CameraRig } from './camera/rig.js';
import { createDaylight, SUN_REFRESH_MS } from './daylight.js';
import {
  attachPointer,
  DEFAULT_WHEEL_POLICY,
  MODIFIER_WHEEL_POLICY,
  type HoverProbe,
  type Intent,
  type WheelPolicy,
} from './input/pointer.js';
import { attachKeyboard, type KeyIntent } from './input/keyboard.js';
import { createSurface, type Surface } from './input/surface.js';
import { type Pose, MAX_ZOOM_RATIO, type Viewport } from './camera/projection.js';
import { createChannels, type Channel } from './channels.js';
import { RenderLoop } from './webgpu/render-loop.js';
import type { FramePasses } from './webgpu/frame-encoder.js';
import {
  PROJECTION_DEFS,
  PROJECTIONS,
  isGeographicTopology,
  type ProjectionFamily,
  type Projection,
} from './projections.js';
import type { Borders } from './borders/index.js';
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

/**
 * Events emitted by a {@link Network} instance, keyed by name with their payload.
 *
 * @remarks
 * `hover` and `select` carry `null` when interaction state clears. Programmatic
 * selection does not emit `select`; user pointer and keyboard selection does.
 */
export type Events = {
  /** Hovered vertex or edge, or null after hover exit. */
  hover: Item | null;
  /** User-selected vertex or edge, or null after a clearing tap or Escape. */
  select: Item | null;
  /**
   * A context request on the canvas, released after right-drag disambiguation, with what a menu
   * needs: where to open and what it is about.
   *
   * The native event's default action is already prevented. `keyboard` is true for the Menu key,
   * Shift+F10, or assistive input, and then the anchor is the selected item's location clamped
   * inside the canvas and `items` is the selection; otherwise the anchor is the pointer and
   * `items` is what {@link Network.hitTest} finds there.
   */
  contextmenu: {
    readonly event: MouseEvent;
    readonly keyboard: boolean;
    readonly clientX: number;
    readonly clientY: number;
    readonly items: readonly Item[];
  };
  /** Whether the camera sits at the fit view, after a fit transition or gesture. */
  fit: boolean;
  /** Whether continuous rotation is running, after {@link Network.orbit} or an interrupting gesture. */
  orbit: boolean;
  /** Bound to a canvas after {@link Network.attach}, or released from one. */
  attached: boolean;
  /**
   * The WebGPU device was lost. The controller releases it, leases a replacement, and replays
   * every retained state; `recovering` is false only when no replacement could be leased, and
   * the controller then stays detached.
   */
  deviceLost: { readonly reason: string; readonly message: string; readonly recovering: boolean };
  /** Asynchronous shader-pipeline build failure; rendering for that family is unavailable. */
  pipelineError: { readonly family: ProjectionFamily; readonly cause: unknown };
};

/**
 * Imperative controller for a WebGPU network canvas.
 *
 * @remarks
 * A controller outlives any canvas and any device. Topology, channels, options, borders,
 * selection, and the camera pose are retained on the CPU side; {@link Network.attach} leases a
 * device, binds a canvas, and replays them, and {@link Network.detach} releases both while keeping
 * every state for the next attach. The controller never removes a canvas or destroys a device.
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
   * ground clipping, border drawing, and globe availability; generated ring
   * layouts are never geographic. False before the first {@link Network.load}.
   */
  readonly geographic: boolean;
  /** Whether continuous rotation is running. */
  readonly orbiting: boolean;
  /** Whether a canvas is bound and rendering. */
  readonly attached: boolean;

  /**
   * Subscribe to a network event and receive an unsubscribe callback.
   *
   * @param event - Event name to observe.
   * @param handler - Callback invoked with the event payload.
   * @returns A function that removes the handler.
   */
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;

  /**
   * Lease a device from the `devices` option and bind `canvas`, replaying every retained state.
   *
   * A newer `attach` or a `detach` supersedes an attach still awaiting its device, which then
   * rejects with an `AbortError`. The previous canvas, if any, is released first.
   *
   * @param canvas - Borrowed canvas used for presentation and input.
   * @throws GpuUnavailableError when no device can be leased.
   * @throws TypeError when the leased device does not provide Core WebGPU features and limits.
   * @throws Error when canvas presentation or renderer initialization fails.
   */
  attach(canvas: HTMLCanvasElement): Promise<void>;
  /** Release the device lease, renderer resources, and canvas listeners; every state stays. */
  detach(): void;

  /**
   * Bind a topology and schedule its first paint.
   *
   * This method is synchronous; read `Network.projections` immediately after it returns. Throws
   * when topology validation or GPU binding fails, leaving the prior view intact. Loading the
   * topology already loaded is a no-op that keeps channels, selection, and the camera.
   *
   * @param topology - CPU-side graph and geometry arrays.
   * @param options - `fit` fits the view to the new topology; pass `false` to keep a placed
   * camera's pose. @defaultValue `{ fit: true }`
   * @throws Error when topology validation or GPU binding fails.
   */
  load(topology: Topology, options?: { readonly fit?: boolean }): void;
  /**
   * Replace the optional geographic border overlay, drawn only over a geographic topology.
   *
   * @param borders - Packed border geometry, or `null` to clear borders.
   * @throws Error when the geometry violates the border layout.
   */
  setBorders(borders: Borders | null): void;
  /**
   * Update display options. `msaa` and `devices` remain construction-only.
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
   * diagonal to keep pathological requests bounded. Empty while detached.
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
   * visibility options do not affect the result. Null while detached.
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
   * An item already inside the `revealPaddingPx` inset is left in place; otherwise the camera
   * centers it while retaining the current scale, distance, tilt, and bearing. With `neighbors`,
   * a populated neighborhood is fitted instead. Newer camera commands replace an in-progress
   * reveal.
   *
   * @param item - Vertex or edge identity in the loaded topology.
   * @param options - `neighbors` frames the item with what touches it; `animate` eases the move,
   * subject to the `motion` option. Both default to `false`.
   * @returns True for a valid item, including an already-visible no-op.
   */
  reveal(
    item: Item,
    options?: { readonly neighbors?: boolean; readonly animate?: boolean },
  ): boolean;
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
   * Drag the content by screen pixels: positive `dx` moves it right, positive `dy` moves it down.
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
   * globe drifts longitude. A pointer, wheel, or keyboard gesture on the canvas stops
   * the orbit, reduced motion refuses to start it, and `orbit` events report every transition.
   *
   * @param active - Whether rotation should run.
   * @returns True when rotation is running afterwards; false when no 3D projection is available.
   */
  orbit(active: boolean): boolean;

  /** Pause animation and rendering until resumed. */
  pause(): void;
  /** Resume rendering when the page and GPU device allow it. */
  resume(): void;
  /** Detach and forget every retained state; the controller cannot be used afterwards. */
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
  attachKeyboard: typeof attachKeyboard;
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
  attachKeyboard,
  Picker,
  createOrbit,
};

/** Shared allocation-free result for invalid or empty public queries. */
const NO_ITEMS: readonly Item[] = Object.freeze([]);

/** Inset that keeps a keyboard context anchor inside the canvas. */
const CONTEXT_INSET_PX = 8;

/** The viewport a detached controller reports: every camera command defers on it. */
const DETACHED_VIEWPORT: Viewport = { w: 0, h: 0 };

/** Runtime options mirrored one-to-one into controller display state. */
const DISPLAY_OPTIONS = [
  'daylight',
  'sunTime',
  'graticule',
  'borders',
  'vertices',
  'edges',
  'poles',
  'vertexScale',
  'edgeScale',
  'heightScale',
  'heightRange',
  'sizeRange',
  'dashPeriodPx',
  'earthAxis',
  'nightFloor',
  'surfaceNightFloor',
  'terminatorWidth',
  'edgeBaseColor',
  'motion',
  'animationMs',
  'orbitRate',
  'revealPaddingPx',
  'pickRadiusPx',
  'keyboard',
  'wheel',
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
  'sizeRange',
  'dashPeriodPx',
]);

/**
 * Creates a WebGPU network controller.
 *
 * @param options - Initial rendering and interaction options.
 * @returns A controller for loading topology, binding channels, and attaching canvases.
 * @throws TypeError or RangeError when any option is invalid.
 *
 * @example
 * ```ts
 * const network = createNetwork({ graticule: true });
 * network.load(topology);
 * await network.attach(canvas);
 * ```
 *
 * The controller owns its renderer resources and the device lease it holds while attached, but
 * never the canvas. Detach or destroy the controller before removing its canvas.
 */
export function createNetwork(options: Options = {}): Network {
  return createNetworkWithDeps(options, DEFAULT_CONTROLLER_DEPS);
}

/** @internal */
export function createNetworkWithDeps(options: Options, deps: ControllerDeps): Network {
  return createNetworkController(resolveOptions(options), deps);
}

/** Rejects devices known not to meet the renderer's Core WebGPU limits. */
function assertDeviceLimits(device: GPUDevice): void {
  const vertexStorage = device.limits.maxStorageBuffersInVertexStage;
  if (vertexStorage !== undefined && vertexStorage < 3) {
    throw new TypeError('A Core WebGPU device is required');
  }
}

/** Resources registered transactionally while a binding is constructed. */
interface ControllerLifecycle {
  add(cleanup: () => void): void;
  destroy(): void;
}

/** Creates an idempotent, reverse-order cleanup stack. */
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

/** Relays one device-loss notification without retaining a released binding. */
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

/** The rejection of an attach that a newer attach or a detach overtook. */
function superseded(): DOMException {
  return new DOMException('The attach was superseded.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Item identity from a pick result. */
function itemOf(hit: PickResult): Item {
  return { kind: hit[0], index: hit[1] };
}

/** Keep a keyboard context anchor inside the canvas; the center when nothing is located. */
function clampToRect(
  point: readonly [number, number] | null,
  rect: DOMRect,
): readonly [number, number] {
  const center: readonly [number, number] = [
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  ];
  if (rect.width <= 0 || rect.height <= 0) return point ?? center;
  const insetX = Math.min(CONTEXT_INSET_PX, rect.width / 2);
  const insetY = Math.min(CONTEXT_INSET_PX, rect.height / 2);
  const [x, y] = point ?? center;
  return [
    Math.min(rect.right - insetX, Math.max(rect.left + insetX, x)),
    Math.min(rect.bottom - insetY, Math.max(rect.top + insetY, y)),
  ];
}

/** Everything one attach owns: released together, replaced together. */
interface Binding {
  /** The attach generation that created it; a stale device loss compares against it. */
  readonly generation: number;
  readonly canvas: HTMLCanvasElement;
  readonly surface: Surface;
  readonly renderer: Renderer;
  readonly loop: RenderLoop;
  readonly lifecycle: ControllerLifecycle;
  keyboard: { destroy(): void } | null;
  sunTimer: ReturnType<typeof setInterval> | null;
  /** First-paint gate for pipeline warming. */
  painted: boolean;
  warmRequested: boolean;
  warming: boolean;
}

/** Creates the controller: every state lives here, and a binding borrows it for one attach. */
function createNetworkController(options: ResolvedOptions, deps: ControllerDeps): Network {
  const events = createEmitter<Events>();
  const uniforms = createUniforms();
  const rig = new deps.CameraRig(uniforms.camera);
  const daylight = createDaylight(uniforms.light);

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
  let scene: PreparedScene | null = null;
  let topologyAdjacency: Adjacency | null = null;
  let topologyBounds: Bounds | null = null;
  let topologyCharacteristicLength: number | null = null;
  let topologyGeographic = false;
  let projections = projectionAvailability(null, null, false);
  let vertexRadius = 0;
  /** The retained border payload, rebound on every attach. */
  let borders: Borders | null = null;
  /** The sampled colormap, retained so a new renderer starts from it; null keeps the default. */
  let colormapLut: Uint8Array | null = null;
  let pipelineFailure: Events['pipelineError'] | null = null;

  let binding: Binding | null = null;
  /** Bumped by every attach, detach, and destroy so an overtaken attach knows to stand down. */
  let generation = 0;
  let destroyed = false;
  let consumerPaused = false;
  let pageVisible = true;

  /** Latest physical hover point; converted through the current DOMRect per pick. */
  let hoverProbe: HoverProbe | null = null;
  /** Aggregate pointer/wheel navigation lifecycle supplied by the input adapter. */
  let navigationActive = false;
  /** Invalidates only semantic picks, avoiding repeated large-scene queries. */
  let hoverDirty = false;
  interface VersionedNotice<T> {
    readonly value: T;
    readonly scene: number;
  }
  /** Focus change awaiting a successful frame submission. */
  let pendingHoverNotice: VersionedNotice<Item | null> | undefined;
  /** Latest submitted focus change awaiting post-tick delivery. */
  let readyHoverNotice: VersionedNotice<Item | null> | undefined;
  /** Fit-state transition awaiting a successful frame submission. */
  let pendingFitNotice: VersionedNotice<boolean> | undefined;
  /** Latest submitted fit-state transition awaiting post-tick delivery. */
  let readyFitNotice: VersionedNotice<boolean> | undefined;
  let noticeDeliveryQueued = false;
  let sceneGeneration = 0;

  /** Schedule a frame for a visual state change. */
  const repaint = (): void => binding?.loop.wake();
  /** Camera state changed: invalidate hover and schedule a frame. */
  const cameraMoved = (): void => {
    hoverDirty = true;
    repaint();
  };
  /** Current canvas viewport in CSS pixels; empty while detached, so camera commands defer. */
  const vp = (): Viewport => (binding ? binding.surface.size() : DETACHED_VIEWPORT);

  /** Whether motion is reduced right now: by option, or by the user's preference under `auto`. */
  function reduced(): boolean {
    if (display.motion === 'reduce') return true;
    if (display.motion === 'full') return false;
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  }
  /** An animation request, honored only when motion is not reduced. */
  const animated = (requested: boolean | undefined): boolean => requested === true && !reduced();

  /** The wheel policy follows the live `wheel` option. */
  const wheelPolicy: WheelPolicy = (event) =>
    (display.wheel === 'modifier' ? MODIFIER_WHEEL_POLICY : DEFAULT_WHEEL_POLICY)(event);

  const channels = createChannels(uniforms, {
    loaded: () => topology !== null,
    vertexCount: () => topology?.vertexCount ?? 0,
    edgeCount: () => (topology ? edgeCountOf(topology) : 0),
    dashPeriodPx: () => display.dashPeriodPx,
    heightRange: () => display.heightRange,
    sizeRange: () => display.sizeRange,
    renderer: () => binding?.renderer ?? null,
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

  /** Whether an item's anchor already sits inside the reveal inset, clamped to a usable band. */
  const insideRevealInset = (item: Item, view: Viewport): boolean => {
    const location = picker.locateDetail([item.kind, item.index], view);
    if (!location?.visible) return false;
    const maximum = Math.max(0, (Math.min(view.w, view.h) - 2) / 2);
    const padding = Math.min(display.revealPaddingPx, maximum);
    const [x, y] = location.point;
    return x >= padding && x <= view.w - padding && y >= padding && y <= view.h - padding;
  };

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

  /** The selected item, if any. */
  function selectedItem(): Item | null {
    if (focus.selectedVertex >= 0) return { kind: 'vertex', index: focus.selectedVertex };
    if (focus.selectedEdge >= 0) return { kind: 'edge', index: focus.selectedEdge };
    return null;
  }

  /** Every pointer gesture the input adapter recognizes, routed to camera, focus, and events. */
  function onPointerIntent(intent: Intent): void {
    const bound = binding;
    if (!bound) return;
    switch (intent.kind) {
      case 'contextmenu': {
        const { event, keyboard } = intent;
        if (keyboard) {
          const selected = selectedItem();
          const [clientX, clientY] = clampToRect(
            selected ? api.locate(selected) : null,
            bound.surface.rect(),
          );
          events.emit('contextmenu', {
            event,
            keyboard,
            clientX,
            clientY,
            items: selected ? [selected] : NO_ITEMS,
          });
        } else {
          events.emit('contextmenu', {
            event,
            keyboard,
            clientX: event.clientX,
            clientY: event.clientY,
            items: api.hitTest(event.clientX, event.clientY),
          });
        }
        break;
      }
      case 'navigationStart':
        orbit.stop();
        navigationActive = true;
        hoverDirty = true;
        applyHover(null);
        bound.loop.wake();
        break;
      case 'navigationEnd':
        navigationActive = false;
        hoverProbe = intent.probe;
        hoverDirty = true;
        bound.loop.wake();
        break;
      case 'dragStart':
        orbit.stop();
        if (!topology) break;
        rig.camera.beginDrag(intent.sx, intent.sy, intent.vp, intent.time);
        break;
      case 'dragMove':
        if (!topology) break;
        if (rig.camera.drag(intent.dx, intent.dy, intent.sx, intent.sy, intent.vp, intent.time)) {
          bound.loop.wake();
        }
        break;
      case 'dragEnd':
        if (!topology) break;
        if (rig.camera.endDrag(intent.coast && !reduced(), intent.time)) bound.loop.wake();
        break;
      case 'pan':
        orbit.stop();
        if (!topology) break;
        if (rig.camera.panBy(intent.dx, intent.dy, intent.vp)) bound.loop.wake();
        break;
      case 'zoom':
        orbit.stop();
        if (!topology) break;
        if (rig.camera.zoomAt(intent.factor, intent.sx, intent.sy, intent.vp)) bound.loop.wake();
        break;
      case 'rotate':
        orbit.stop();
        if (!topology) break;
        if (rig.camera.rotateBy(intent.dxPx, intent.dyPx, intent.vp)) bound.loop.wake();
        break;
      case 'tap':
        if (!topology) break;
        cycleSelection(picker.pickAll(pickQueryAt(intent.sx, intent.sy, intent.targetPx)));
        break;
      case 'doubleTap':
        orbit.stop();
        if (!topology || !topologyBounds) break;
        rig.fit(intent.vp, !reduced());
        bound.loop.wake();
        break;
      case 'hover':
        hoverProbe = intent;
        hoverDirty = true;
        bound.loop.wake();
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
  }

  /** Every keyboard gesture, routed through the public camera verbs so hosts see one behavior. */
  function onKeyIntent(intent: KeyIntent): void {
    if (!topology) return;
    switch (intent.kind) {
      case 'pan':
        orbit.stop();
        api.panBy(intent.dx, intent.dy);
        break;
      case 'rotate':
        orbit.stop();
        api.rotateBy(intent.dx, intent.dy);
        break;
      case 'zoom':
        orbit.stop();
        api.zoomBy(intent.factor);
        break;
      case 'fit':
        orbit.stop();
        api.fit(true);
        break;
      case 'clear':
        if (selectedItem()) commitUserSelection(null);
        break;
      default:
        /* v8 ignore next -- compile-time exhaustive keyboard intent guard. */
        intent satisfies never;
    }
  }

  /** Switch projection through the rig and renderer together; false when unsupported. */
  function switchProjection(mode: Projection): boolean {
    if (!projections[mode]) return false;
    if (mode === rig.mode) return true;
    rig.switchTo(mode, vp());
    updateHeightAmplitude(vp());
    binding?.renderer.useProjection(mode);
    cameraMoved();
    return true;
  }

  /** Build every device-bound collaborator for one attach; on any failure nothing is kept. */
  function bind(lease: DeviceLease, canvas: HTMLCanvasElement, own: number): Binding {
    const lifecycle = createControllerLifecycle();
    // Registered first, so it runs last: nothing outlives the lease it renders on.
    lifecycle.add(() => lease.release());
    try {
      const surface = deps.createSurface(canvas);
      lifecycle.add(() => surface.destroy());

      const presentation = deps.createPresentation(lease.device, canvas);
      lifecycle.add(() => presentation.destroy());
      const renderer = new deps.Renderer(presentation, options.msaa);
      lifecycle.add(() => renderer.destroy());

      const loop = new deps.RenderLoop({
        presentation,
        uniforms,
        renderer,
        rig,
        onZoom: (atFitView) => stageFitNotice(atFitView),
        onBeforeFrame: (frameVp) => {
          daylight.refresh(display.sunTime ?? Date.now());
          updateHeightAmplitude(frameVp);
        },
        onFrame: (sizeSettled) => resolveHover(sizeSettled),
        onPaint: () => onSuccessfulPaint(),
      });
      lifecycle.add(() => loop.destroy());

      renderer.onPipelinesReady = () => loop.wake();
      renderer.onPipelineError = (family, cause) => {
        pipelineFailure = { family, cause };
        events.emit('pipelineError', pipelineFailure);
      };

      const pointer = deps.attachPointer(surface, onPointerIntent, {
        wheel: wheelPolicy,
        pickRadiusPx: () => display.pickRadiusPx,
      });
      lifecycle.add(() => pointer.destroy());

      pageVisible = typeof document !== 'undefined' ? !document.hidden : true;
      const onVisibilityChange = (): void => {
        pageVisible = !document.hidden;
        syncRenderLoopActivity();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      lifecycle.add(() => document.removeEventListener('visibilitychange', onVisibilityChange));

      lifecycle.add(forwardDeviceLoss(lease.device, (info) => recover(own, info)));

      const entry: Binding = {
        generation: own,
        canvas,
        surface,
        renderer,
        loop,
        lifecycle,
        keyboard: null,
        sunTimer: null,
        painted: false,
        warmRequested: false,
        warming: false,
      };
      lifecycle.add(() => {
        entry.keyboard?.destroy();
        entry.keyboard = null;
        if (entry.sunTimer !== null) clearInterval(entry.sunTimer);
        entry.sunTimer = null;
      });
      return entry;
    } catch (error) {
      lifecycle.destroy();
      throw error;
    }
  }

  /** Push every retained state into a freshly bound renderer and paint. */
  function replayInto({ renderer, loop }: Binding): void {
    if (colormapLut) renderer.writeColormap(colormapLut);
    renderer.setPasses(passes());
    if (scene) {
      renderer.bindTopology(scene);
      renderer.useProjection(rig.mode);
      channels.upload(renderer);
    }
    renderer.setBorders(borders);
    loop.frameNow();
  }

  /** Release the current binding, if any, and say so. */
  function release(): void {
    const entry = binding;
    if (!entry) return;
    binding = null;
    orbit.stop();
    hoverProbe = null;
    navigationActive = false;
    hoverDirty = false;
    pendingHoverNotice = undefined;
    readyHoverNotice = undefined;
    pendingFitNotice = undefined;
    readyFitNotice = undefined;
    focus.setHover(null);
    entry.lifecycle.destroy();
    if (!destroyed) events.emit('attached', false);
  }

  /** A device the platform lost: release it, say so, and lease a replacement. */
  function recover(own: number, info: GPUDeviceLostInfo): void {
    const entry = binding;
    if (!entry || entry.generation !== own || destroyed) return;
    const { canvas } = entry;
    release();
    events.emit('deviceLost', {
      reason: info.reason ?? 'unknown',
      message: info.message || 'WebGPU device was lost',
      recovering: true,
    });
    api.attach(canvas).catch((error: unknown) => {
      // A newer attach or a detach overtook the recovery; it owns the outcome now.
      if (isAbortError(error) || destroyed) return;
      events.emit('deviceLost', {
        reason: 'unavailable',
        message: describe(error),
        recovering: false,
      });
    });
  }

  /** Keeps loop activity consistent with user pause and page visibility. */
  function syncRenderLoopActivity(): void {
    const loop = binding?.loop;
    if (!loop) return;
    if (!consumerPaused && pageVisible) loop.resume();
    else loop.pause();
  }

  /** Attach or detach the keyboard map to follow the live `keyboard` option. */
  function syncKeyboard(): void {
    const entry = binding;
    if (!entry) return;
    if (display.keyboard && !entry.keyboard) {
      entry.keyboard = deps.attachKeyboard(entry.canvas, onKeyIntent);
    } else if (!display.keyboard && entry.keyboard) {
      entry.keyboard.destroy();
      entry.keyboard = null;
    }
  }

  /** Arm the periodic daylight wake only while the sun follows the clock over a geographic topology. */
  function syncSunTimer(): void {
    const entry = binding;
    if (!entry) return;
    const armed = display.daylight && topologyGeographic && display.sunTime === null;
    if (armed && entry.sunTimer === null) {
      entry.sunTimer = setInterval(() => entry.loop.wake(), SUN_REFRESH_MS);
    } else if (!armed && entry.sunTimer !== null) {
      clearInterval(entry.sunTimer);
      entry.sunTimer = null;
    }
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

    get attached() {
      return binding !== null;
    },

    on(event, handler) {
      const unsubscribe = events.on(event, handler);
      if (event === 'pipelineError' && pipelineFailure) {
        replay(handler as (payload: Events['pipelineError']) => void, pipelineFailure);
      }
      return unsubscribe;
    },

    async attach(canvas) {
      if (destroyed) throw new Error('network: the controller is destroyed');
      const own = ++generation;
      release();
      const lease = await options.devices.acquire();
      if (own !== generation || destroyed) {
        lease.release();
        throw superseded();
      }
      try {
        assertDeviceLimits(lease.device);
      } catch (error) {
        lease.release();
        throw error;
      }
      const entry = bind(lease, canvas, own);
      binding = entry;
      try {
        syncKeyboard();
        syncSunTimer();
        syncRenderLoopActivity();
        replayInto(entry);
      } catch (error) {
        binding = null;
        entry.lifecycle.destroy();
        throw error;
      }
      events.emit('attached', true);
    },

    detach() {
      generation++;
      release();
    },

    load(next, loadOptions = {}) {
      loadTopology(next, loadOptions.fit ?? true);
    },

    setBorders(next) {
      // Validate through a renderer when one is bound; a detached controller validates at attach.
      binding?.renderer.setBorders(next);
      borders = next;
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

    hitTest(clientX, clientY, radiusPx = display.pickRadiusPx) {
      const bound = binding;
      if (
        !bound ||
        !topology ||
        !Number.isFinite(clientX) ||
        !Number.isFinite(clientY) ||
        !Number.isFinite(radiusPx) ||
        radiusPx < 0
      ) {
        return NO_ITEMS;
      }

      const rect = bound.surface.rect();
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
      const bound = binding;
      if (!bound || !topology) return null;
      const rect = bound.surface.rect();
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
        rig.fit(vp(), animated(itemsOrAnimate));
      } else {
        if (!topologyBounds) return;
        const { view, bounds } = resolveItemBounds(itemsOrAnimate);
        if (!bounds) return;
        rig.moveTo(
          expandDegenerateBounds(bounds, topologyBounds, MAX_ZOOM_RATIO),
          view,
          animated(animate),
        );
      }
      cameraMoved();
    },

    reveal(item, { neighbors = false, animate = false } = {}) {
      if (!topology || !topologyBounds) return false;
      const items = neighbors ? api.neighborhood(item) : [item];
      const { view, hasViewport, bounds } = resolveItemBounds(items);
      if (!bounds) return false;

      if (items.length > 1) {
        rig.moveTo(
          expandDegenerateBounds(bounds, topologyBounds, MAX_ZOOM_RATIO),
          view,
          animated(animate),
        );
      } else if (hasViewport && insideRevealInset(item, view)) {
        if (rig.claim()) cameraMoved();
        return true;
      } else {
        rig.reveal(bounds, view, animated(animate));
      }
      cameraMoved();
      return true;
    },

    getPose() {
      if (!topology) return null;
      return rig.camera.pose();
    },

    setPose(pose, animate = false) {
      if (!topology) return false;
      if (!rig.camera.setPose(pose, animated(animate))) return false;
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
      if (!topology || reduced()) return false;
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
      if (destroyed) return;
      destroyed = true;
      generation++;
      release();
      pendingHoverNotice = undefined;
      readyHoverNotice = undefined;
      pendingFitNotice = undefined;
      readyFitNotice = undefined;
      topology = null;
      scene = null;
      topologyAdjacency = null;
      topologyBounds = null;
      topologyCharacteristicLength = null;
      borders = null;
      rig.setBounds(null);
      picker.commitScene(null);
      channels.reset();
      events.clear();
    },
  };

  const orbit = deps.createOrbit(
    api,
    (active) => {
      if (!destroyed) events.emit('orbit', active);
    },
    { rate: () => display.orbitRate },
  );

  /** Warms currently supported inactive projections in serial build order. */
  function warmInactiveProjections(): void {
    const entry = binding;
    if (!entry || !entry.painted || destroyed) return;
    entry.warmRequested = true;
    if (entry.warming) return;
    entry.warming = true;

    void (async () => {
      try {
        while (entry.warmRequested && binding === entry && !destroyed) {
          entry.warmRequested = false;
          for (const mode of PROJECTIONS) {
            if (mode !== rig.mode && projections[mode]) {
              try {
                await entry.renderer.warmProjection(mode);
              } catch (error) {
                console.error(`network: failed to warm the ${mode} projection pipelines`, error);
              }
            }
            if (binding !== entry || destroyed) return;
          }
        }
      } finally {
        entry.warming = false;
        if (entry.warmRequested && binding === entry) warmInactiveProjections();
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
    const entry = binding;
    if (entry && !entry.painted) {
      entry.painted = true;
      warmInactiveProjections();
    }
    let promoted = false;
    if (pendingFitNotice) {
      readyFitNotice = pendingFitNotice;
      pendingFitNotice = undefined;
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
      const fitNotice = readyFitNotice;
      const hoverNotice = readyHoverNotice;
      readyFitNotice = undefined;
      readyHoverNotice = undefined;
      if (destroyed) return;
      // Preserve the pre-submit ordering: fit state changes precede hover
      // resolution. A fit listener may replace the scene, in which case the
      // generation check suppresses the now-stale hover notice below.
      if (fitNotice?.scene === sceneGeneration) events.emit('fit', fitNotice.value);
      if (hoverNotice?.scene === sceneGeneration) events.emit('hover', hoverNotice.value);
    });
  }

  /** Stage a fit-state event for the frame that submits the new camera state. */
  function stageFitNotice(atFitView: boolean): void {
    pendingFitNotice = { value: atFitView, scene: sceneGeneration };
  }

  /** Validate and apply one public runtime option patch as a single repaint. */
  function updateOptions(opts: Options): void {
    validateOptions(opts);
    const patch = runtimeOptionPatch(opts);
    if (Object.keys(patch).length === 0) return;
    if (applyOptions(patch)) hoverDirty = true;
    repaint();
  }

  /** The passes the renderer draws: borders only over geographic coordinates. */
  function passes(): FramePasses {
    return {
      vertices: display.vertices,
      edges: display.edges,
      poles: display.poles,
      borders: display.borders && topologyGeographic,
      earthAxis: display.earthAxis,
    };
  }

  /** Applies construction or runtime display options. */
  function applyOptions(opts: Options, initial = false): boolean {
    // The colormap is sampled before anything is applied: caller code may throw.
    const lut =
      opts.colormap && (!initial || opts.colormap !== DEFAULT_OPTIONS.colormap)
        ? bakeColormap(opts.colormap)
        : null;
    if (lut) {
      colormapLut = lut;
      binding?.renderer.writeColormap(lut);
    }
    if (opts.vertexBaseColor) uniforms.vBaseColor.set(opts.vertexBaseColor);
    if (opts.edgeBaseColor) uniforms.eBaseColor.set(opts.edgeBaseColor);
    if (opts.graticuleColor) uniforms.graticuleColor.set(opts.graticuleColor);
    if (opts.surfaceColor) uniforms.surfaceColor.set(opts.surfaceColor);
    if (opts.borderColor) uniforms.borderColor.set(opts.borderColor);
    let pickGeometryChanged = false;
    for (const key of DISPLAY_OPTIONS) {
      const value = opts[key];
      if (value === undefined || value === display[key]) continue;
      (display as Record<DisplayOption, DisplayState[DisplayOption]>)[key] = (
        Array.isArray(value) ? [...(value as readonly number[])] : value
      ) as DisplayState[DisplayOption];
      if (PICK_GEOMETRY_OPTIONS.has(key)) pickGeometryChanged = true;
    }
    if (opts.dashPeriodPx !== undefined) channels.refreshDashPeriod();
    if (opts.heightRange !== undefined) channels.refreshHeightRange();
    if (opts.sizeRange !== undefined || initial) channels.refreshSizeRange();
    if (opts.sunTime !== undefined) daylight.refresh(display.sunTime ?? Date.now(), true);
    if (opts.animationMs !== undefined) rig.animationMs = display.animationMs;
    applyFocusOptions(opts);
    binding?.renderer.setPasses(passes());
    writeDisplayToUniforms();
    writeGeometryScales(vp());
    syncKeyboard();
    syncSunTimer();
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

  /** Writes display flags and lighting scalars into uniforms. */
  function writeDisplayToUniforms(): void {
    // Daylight interprets coordinates as lon/lat degrees, so it arms only for
    // geographic topologies; every projection family shades when it is set.
    // DISPLAY_GEOGRAPHIC tracks the topology alone: the plane background clips
    // its ground to the lon/lat world rect whenever coordinates are degrees.
    // DISPLAY_VERTICES lets edges end at the discs the vertex pass draws.
    uniforms.display.flags =
      (display.daylight && topologyGeographic ? DISPLAY_DAYLIGHT : 0) |
      (display.graticule ? DISPLAY_GRATICULE : 0) |
      (topologyGeographic ? DISPLAY_GEOGRAPHIC : 0) |
      (display.edgeBaseColor ? DISPLAY_EDGE_BASE_COLOR : 0) |
      (display.vertices ? DISPLAY_VERTICES : 0);
    uniforms.light.nightFloor = display.nightFloor;
    uniforms.light.surfaceNightFloor = display.surfaceNightFloor;
    uniforms.light.terminatorWidth = display.terminatorWidth;
  }

  /** Returns endpoint vertex ids for focus halos, or [-1, -1] when invalid. */
  function edgeEndpoints(edgeIndex: number): [number, number] {
    const edge = topology?.edges;
    if (!edge || edgeIndex < 0) return [-1, -1];
    const a = edge[edgeIndex * 2];
    const b = edge[edgeIndex * 2 + 1];
    return a === undefined || b === undefined ? [-1, -1] : [a, b];
  }

  /** Updates projection-specific height amplitude from current viewport state. */
  function updateHeightAmplitude(frameVp: Viewport): void {
    if (!topology || !topologyBounds) return;
    const scale = PROJECTION_DEFS[rig.mode].heightAmplitude(
      topologyBounds,
      frameVp,
      vertexRadius * display.vertexScale,
    );
    uniforms.geometry.heightAmplitude = scale * display.heightScale;
  }

  /** Writes topology-derived geometry sizes through the current display multipliers. */
  function writeGeometryScales(frameVp: Viewport): void {
    if (topologyCharacteristicLength === null) return;
    uniforms.geometry.vRadius = vertexRadius * display.vertexScale;
    uniforms.geometry.eHalfWidth =
      topologyCharacteristicLength * VISUAL.edgeHalfWidthFraction * display.edgeScale;
    updateHeightAmplitude(frameVp);
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
    const bound = binding;
    if (!bound || !topology || !hoverProbe || navigationActive) {
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
      const rect = bound.surface.rect();
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
   * the descriptive error propagates to the caller. The topology already loaded is
   * recognized by content in one early-exit pass, before anything is validated or
   * encoded, and then nothing changes.
   */
  function loadTopology(next: Topology, fit: boolean): void {
    if (topology && sameTopology(topology, next)) return;
    const prepared = prepareTopology(next);
    const encoded = encodeTopology(prepared);
    const encodedSegments = encodeSegments(prepared);
    const nextScene = prepareScene(encoded, encodedSegments);
    const pickScene = picker.prepareScene(nextScene);
    binding?.renderer.bindTopology(nextScene);
    picker.commitScene(pickScene);

    const info = nextScene.info;
    scene = nextScene;
    topology = next;
    topologyAdjacency = null;
    sceneGeneration++;
    pendingHoverNotice = undefined;
    readyHoverNotice = undefined;
    pendingFitNotice = undefined;
    readyFitNotice = undefined;
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
      binding?.renderer.useProjection('flat');
    }

    vertexRadius = info.characteristicLength * VISUAL.vertexRadiusFraction;
    writeGeometryScales(vp());
    // New bounds can change the geographic gates: daylight, ground clipping, borders.
    writeDisplayToUniforms();
    binding?.renderer.setPasses(passes());
    syncSunTimer();

    channels.reset();
    // A fresh scene schedules its canonical fit on the rig, unless the caller keeps the pose.
    rig.setBounds(topologyBounds, fit);
    warmInactiveProjections();
    binding?.loop.frameNow();
  }

  return api;
}
