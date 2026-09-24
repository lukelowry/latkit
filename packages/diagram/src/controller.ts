/// <reference types="@webgpu/types" />

import {
  bakeColormap,
  createEmitter,
  validateNetlist,
  type Domain,
  type Netlist,
} from '@latkit/model';
import {
  createFrameLoop,
  createPresentation,
  type DeviceLease,
  type Frame,
  type FrameLoop,
  type Presentation,
} from '@latkit/gpu';

import { Camera, type Pose, type Viewport } from './camera.js';
import { createChannels, type Channel } from './channels.js';
import { Focus } from './focus.js';
import { snapTo, type Rect } from './geometry.js';
import { attachGestures, type Gesture } from './input/gestures.js';
import { attachKeyboard, type KeyIntent } from './input/keyboard.js';
import { createSurface, type Surface } from './input/surface.js';
import { Interactor, type InteractionContext } from './interact.js';
import {
  OPTIONS,
  resolveOptions,
  validateOptions,
  type Options,
  type ResolvedOptions,
} from './options.js';
import {
  idOf,
  PART_BLOCK,
  PART_GROUP,
  PART_NET,
  PART_PORT,
  partId,
  partIndex,
  partKind,
  partOf,
  type Part,
} from './part.js';
import { NONE, sameNetlist, type Prepared } from './prepare.js';
import { routePreview } from './route/orthogonal.js';
import { Scene } from './scene.js';
import type { Shade, ShadeFrame } from './shade.js';
import { Atlas, canvasRasterizer, type Rasterizer } from './text/atlas.js';
import { Labels } from './text/labels.js';
import {
  createMirrors,
  layoutBases,
  OVERLAY_ALONG,
  OVERLAY_GHOST,
  OVERLAY_MARQUEE,
  OVERLAY_PREVIEW,
  OVERLAY_WORDS,
  type DrawCounts,
} from './webgpu/buffers.js';
import { Renderer } from './webgpu/renderer.js';
import {
  createUniforms,
  DISPLAY_ARROWS,
  DISPLAY_EDIT,
  DISPLAY_GRID,
  DISPLAY_JUNCTIONS,
  DISPLAY_LABELS,
  DISPLAY_REDUCED,
} from './webgpu/uniforms.js';

export type { Options } from './options.js';

/**
 * Events emitted by a {@link Diagram}, keyed by name with their payload.
 *
 * @remarks
 * User gestures produce `select`, `contextmenu`, `open`, `connect`, `move`, and `delete`;
 * programmatic calls never emit them. `hover` follows whatever lies under the pointer after any
 * change, a call's as much as a gesture's: a pan, a fit, a load, a placement, or a visibility
 * write can emit it, and `pause` clears it at once. `fit` reports every transition to or from the
 * fit view, whatever moved the camera. `connect`, `move`, and `delete` are proposals: the diagram
 * never edits its netlist, a host decides and loads the result. Handlers never run inside a frame:
 * what a frame resolves (`painted`, `fit`, and hover under the pointer) is delivered in a
 * microtask after it submits.
 */
export type Events = {
  /**
   * The part under the pointer, or null: resolved by the frame after the pointer moves, the view
   * moves or comes to rest, or a load or edit changes what lies there; cleared at once when a drag
   * starts.
   */
  hover: Part | null;
  /**
   * The selection after a tap, marquee, modifier-click, Tab, or Escape. Programmatic `select`
   * never emits.
   */
  select: readonly Part[];
  /**
   * A context request on the canvas, released after right-drag disambiguation, with what a menu
   * needs: where to open and what it is about.
   *
   * The native event's default action is already prevented. `keyboard` is true for the Menu key,
   * Shift+F10, or assistive input, and then the anchor is the first selected part's location
   * clamped inside the canvas and `parts` is the selection; otherwise the anchor is the pointer and
   * `parts` is what {@link Diagram.hitTest} finds there. The selection does not change.
   */
  contextmenu: {
    readonly event: MouseEvent;
    readonly keyboard: boolean;
    readonly clientX: number;
    readonly clientY: number;
    readonly parts: readonly Part[];
  };
  /** Double-click or Enter on a part. */
  open: Part;
  /** A wire the user drew. Nothing changes until a netlist that has it is loaded. */
  connect: {
    /**
     * The port at the wire's fixed end: where a new wire started, or the far end of a picked-up
     * wire (its net's driver, else another port on it).
     */
    readonly from: number;
    /** The port or net it ended on; null over empty canvas, where a host offers to add a block. */
    readonly to: { readonly kind: 'port' | 'net'; readonly index: number } | null;
    /** The port whose wire the drag picked up, for a reconnect; null for a new wire. */
    readonly replaces: number | null;
    /** Where it was released, in diagram units, snapped to the grid when `snap` is on. */
    readonly point: readonly [x: number, y: number];
    readonly clientX: number;
    readonly clientY: number;
  };
  /**
   * Blocks the user dragged or nudged, and the top-left corners they came to rest at, two floats
   * per block: each block's corner before the move plus the move's offset, which is snapped to the
   * grid when `snap` is on (a nudge moves whole grid steps), so a block that started off the grid
   * stays off it.
   *
   * Already shown there, as placements in the `blockPosition` channel: a load keeps them for
   * every block whose key survives, and a host undoes the move by writing the old corners, or NaN
   * for a block that had no placement.
   */
  move: { readonly blocks: Uint32Array; readonly positions: Float32Array };
  /** Delete or Backspace over a selection. A proposal, like `connect`. */
  delete: readonly Part[];
  /**
   * Whether the camera sits at the fit view, where {@link Diagram.fit} without parts puts it;
   * framing some parts or revealing one leaves it. Reported after the frame that changes it.
   */
  fit: boolean;
  /** Bound to a canvas after {@link Diagram.attach}, or released from one. */
  attached: boolean;
  /** True after the first successful frame since attach; false again when the canvas is released. */
  painted: boolean;
  /**
   * The WebGPU device was lost. The controller releases it, leases a replacement, and replays
   * every retained state. `recovering` is false when the controller stays detached: no
   * replacement could be leased, or the host already detached or attached anew from its
   * `attached` handler. A `detach` or `attach` from this handler also wins over the recovery.
   */
  deviceLost: { readonly reason: string; readonly message: string; readonly recovering: boolean };
  /**
   * An asynchronous shader-pipeline build failed; nothing draws until a later
   * {@link Diagram.setShade} succeeds. The latest failure replays to late subscribers.
   */
  pipelineError: { readonly cause: unknown };
};

/**
 * Imperative controller for a WebGPU block-diagram canvas.
 *
 * @remarks
 * A controller outlives any canvas and any device. The netlist, channels, options, selection, and
 * camera pose are retained on the CPU side; {@link Diagram.attach} leases a device, binds a
 * canvas, and replays them, and {@link Diagram.detach} releases both while keeping every state for
 * the next attach. The controller never removes a canvas, destroys a device, or edits a netlist:
 * what the user draws, moves, or deletes arrives as a proposal event.
 */
export interface Diagram {
  /** Whether a canvas is bound and rendering. */
  readonly attached: boolean;
  /** Whether a frame has been painted since attach. */
  readonly painted: boolean;

  /**
   * Subscribe to a diagram event and receive an unsubscribe callback.
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
   * @throws TypeError when the leased device does not provide Core WebGPU limits (five storage
   * buffers in the vertex stage).
   * @throws Error when the controller is destroyed, or canvas presentation or renderer
   * initialization fails.
   */
  attach(canvas: HTMLCanvasElement): Promise<void>;
  /** Release the device lease, renderer resources, and canvas listeners; every state stays. */
  detach(): void;
  /**
   * Schedule a frame and resolve once it is painted.
   *
   * @remarks
   * Waits for a pending shade and a deferred camera placement, and for `resume()` while paused.
   * Rejects with `InvalidStateError` while detached, with `AbortError` on detach, and with the
   * cause of a pipeline failure.
   */
  paint(): Promise<void>;

  /**
   * Bind a netlist and schedule its first paint.
   *
   * Validates before changing anything; the same object, or a content-equal netlist, is a no-op
   * that keeps channels, selection, and the camera. Otherwise blocks whose `blockKey` survives
   * keep their automatic position, their placement, and their selection, and so do their ports,
   * the nets through any surviving port, and the groups through any surviving member; new blocks
   * land beside what they connect to, and a netlist where nothing survives is arranged whole.
   * Removed blocks fade out. Every channel clears except `blockPosition`, whose placements follow
   * their blocks' keys: a new block has none. Hover clears, and the next frame resolves it again
   * at the pointer. A drag or wire in flight is abandoned.
   *
   * Nothing draws until the next frame, so channels bound right after a load, in the same task,
   * show in the load's first frame.
   *
   * An empty netlist is a diagram too: the camera keeps its pose, or starts at the origin at
   * actual size, so `toDiagram` and the camera calls keep working for a first block.
   *
   * @param netlist - The diagram's structure.
   * @param options - `fit` fits the view to the new netlist, deferred until a viewport exists;
   * pass `false` to keep a placed camera's pose. @defaultValue `{ fit: true }`
   * @throws Error naming the first invalid netlist field; nothing changes.
   */
  load(netlist: Netlist, options?: { readonly fit?: boolean }): void;
  /**
   * Update options. `devices` remains construction-only; a new `gridPitch` re-sizes and
   * re-arranges (placements keep their values), a new `interaction` abandons a gesture in flight.
   *
   * @param options - Partial option patch.
   * @throws TypeError or RangeError when any option is invalid, or what a new `colormap` throws;
   * nothing is applied.
   */
  setOptions(options: Options): void;
  /**
   * Bind, replace, or clear a per-block, per-port, or per-net channel.
   *
   * `blockPosition` places blocks: `x, y` top-left corners, `2 * blockCount` floats, taking effect
   * at once; a NaN pair hands a block back to its automatic position. Placing a block re-routes
   * its nets and moves its group's frame. `blockVisible` and `netVisible` re-route what they
   * touch. `domain` configures the colormap channels only; without one they normalize `[0, 1]`.
   *
   * @param channel - Channel name to bind.
   * @param values - One value per item of the channel's scope (two per block for
   * `blockPosition`), or `null` to clear.
   * @param domain - Input domain for `blockColor` and `netColor`, or `null` for `[0, 1]`.
   * @throws Error when values are given before a netlist is loaded or their length is wrong;
   * `null` is always accepted.
   */
  setChannel(channel: Channel, values: Float32Array | null, domain?: Domain | null): void;
  /**
   * Override the input domain of a colormap channel; raw channels accept it as a no-op.
   *
   * @param channel - Channel name to update.
   * @param domain - Fixed input domain, or `null` to return to the channel's own.
   */
  setChannelDomain(channel: Channel, domain: Domain | null): void;
  /**
   * The input domain a bound colormap channel is using, or null for an unbound or raw channel.
   *
   * @param channel - Channel name to read.
   */
  getChannelDomain(channel: Channel): Domain | null;

  /**
   * Recompute the automatic layout of what `parts` touch, or of everything.
   *
   * A block's arrangement unit is its group, else the blocks wired to it; a port counts as its
   * block, a net as its blocks, a group as its members. Each unit re-arranges anchored at its
   * current top-left, keeping the gap a packing keeps from every other unit (one that grew into it
   * moves down, or below everything), and with no `parts` everything re-arranges and repacks.
   * Blocks without a placement move there, eased when `animate` and motion allows. Placements are
   * never changed: write NaN to hand a placed block to the fresh layout, or write the returned
   * positions to keep the arrangement. Emits no selection or proposal; `hover` follows what the
   * move brings under the pointer.
   *
   * @param parts - Parts whose units to arrange; all when omitted, none when empty.
   * @param options - `animate` eases the move. @defaultValue `{ animate: false }`
   * @returns The automatic top-left of every block, `2 * blockCount` floats, a new array; empty
   * before a load.
   */
  arrange(parts?: readonly Part[], options?: { readonly animate?: boolean }): Float32Array;
  /**
   * Replace the selection with the valid parts, without emitting `select`.
   *
   * @param parts - Parts to select; an empty array clears.
   */
  select(parts: readonly Part[]): void;
  /**
   * The parts under a client point without changing focus: at most one of each kind, the
   * nearest, in priority order port, block, net, group. Hidden parts never match.
   *
   * @param clientX - Client-space horizontal coordinate in CSS pixels.
   * @param clientY - Client-space vertical coordinate in CSS pixels.
   * @param radiusPx - Search radius in CSS pixels, clamped to the canvas diagonal; the
   * `pickRadiusPx` option when omitted.
   * @returns Matching parts in priority order; empty while detached, before the camera is placed,
   * or outside the canvas.
   */
  hitTest(clientX: number, clientY: number, radiusPx?: number): readonly Part[];
  /**
   * A part's anchor in client coordinates: a block's center, a port's position, a net's label
   * anchor or else its driver port (else its first port), a group header's center. It may lie
   * outside the canvas. A hidden block or port still locates; a net with no wires drawn (hidden,
   * drawn as tags, or with fewer than two shown ports) anchors at its driver port; a group's
   * header follows its shown members, so one whose members are all hidden has no anchor.
   *
   * @param part - A part of the loaded netlist.
   * @returns The client coordinate, or null while detached, before the camera is placed, for an
   * invalid part, or for a group with no shown member.
   */
  locate(part: Part): readonly [clientX: number, clientY: number] | null;
  /**
   * The part plus what touches it: a block's nets and the other blocks on them; a port's block,
   * its net, and the other ports on that net; a net's ports and their blocks; a group's blocks.
   *
   * @param part - A part of the loaded netlist.
   * @returns The neighborhood without duplicates, beginning with `part`; empty before a load or
   * for an invalid part.
   */
  neighborhood(part: Part): readonly Part[];
  /**
   * Bring a part into view without changing selection or zoom.
   *
   * A part whose anchor already sits inside the `revealPaddingPx` inset is left in place, and a
   * camera move still in flight stops where it is, so it cannot carry the part away; otherwise
   * the camera centers it at the current zoom. With `neighbors`, a populated neighborhood (the
   * part and anything touching it) is framed instead, as `fit(parts)` frames parts; a part that
   * touches nothing is revealed as without it. Neither redefines the fit view.
   *
   * @param part - A part of the loaded netlist.
   * @param options - `neighbors` frames the part with what touches it; `animate` eases the move,
   * subject to the `motion` option. Both default to `false`.
   * @returns True for a valid, shown part, including an already-visible no-op.
   */
  reveal(
    part: Part,
    options?: { readonly neighbors?: boolean; readonly animate?: boolean },
  ): boolean;
  /**
   * Fit every visible block, with its tags, label, wires, and group frame, into the viewport,
   * inset by `fitPaddingPx`; deferred until a viewport exists. This is the fit view the `fit`
   * event reports on, and a camera left there re-fits when the canvas resizes. A diagram with
   * nothing visible keeps its pose.
   *
   * @param animate - If true, ease toward the fit view, subject to the `motion` option.
   */
  fit(animate?: boolean): void;
  /**
   * Frame the bounds of the valid, shown parts in the viewport, as a fit frames everything,
   * without changing selection or redefining the fit view: `fit` reports false once the camera
   * lands elsewhere, and a resize keeps the pose. Deferred until a viewport exists; an empty
   * valid subset is a no-op.
   *
   * @param parts - Parts to frame.
   * @param animate - If true, ease toward the view, subject to the `motion` option.
   */
  fit(parts: readonly Part[], animate?: boolean): void;
  /**
   * The diagram point under a client point, snapped to the grid when `snap` is on: where a
   * palette drop lands.
   *
   * @param clientX - Client-space horizontal coordinate in CSS pixels.
   * @param clientY - Client-space vertical coordinate in CSS pixels.
   * @returns The diagram point, or null while detached or before the camera is placed.
   */
  toDiagram(clientX: number, clientY: number): readonly [x: number, y: number] | null;
  /**
   * Read the camera pose the next {@link Diagram.setPose} builds on.
   *
   * @returns The current pose, or null before a load or before the camera is placed.
   */
  getPose(): Pose | null;
  /**
   * Merge a partial pose, its zoom clamped to the limits the content sets. Before the camera is
   * placed the pose is kept and applied over its first fit.
   *
   * @param pose - Pose fields to change; omitted fields keep their value.
   * @param animate - If true, ease toward the pose, subject to the `motion` option.
   * @returns True when the camera changed; false before a load.
   * @throws RangeError naming a pose field that is not finite, or a zoom that is not positive.
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
   * Zoom around the viewport center; a no-op while detached.
   *
   * @param factor - Multiplicative zoom factor.
   */
  zoomBy(factor: number): void;
  /**
   * Report the pointer from outside the canvas, or its absence with `null`.
   *
   * It drives hover picking, `hover` events, and the shade's pointer exactly as the canvas's own
   * pointer does; the latest report from either source wins. Meant for a canvas that receives no
   * pointer events itself, such as one under page content.
   *
   * @param clientX - Client-space horizontal coordinate in CSS pixels, or `null` to release.
   * @param clientY - Client-space vertical coordinate in CSS pixels.
   */
  setPointer(clientX: number, clientY: number): void;
  setPointer(clientX: null): void;
  /**
   * Install a fragment shade for the block, port, wire, and group passes, or remove it with
   * `null`.
   *
   * Resolves once those passes draw with it. Rejects, keeping the previous shade, when the WGSL
   * does not compile. While detached it resolves at once and the shade is compiled on attach,
   * where a fault surfaces as `pipelineError`.
   *
   * @param shade - The host shade, or `null` for the identity shade.
   */
  setShade(shade: Shade | null): Promise<void>;

  /** Pause animation and rendering until resumed; hover clears at once, emitting `hover`. */
  pause(): void;
  /** Resume rendering when the page and GPU device allow it. */
  resume(): void;
  /** Detach and forget every retained state; the controller cannot be used afterwards. */
  destroy(): void;
}

/** Internal collaborator seam used by controller behavior tests. */
export interface ControllerDeps {
  createSurface: typeof createSurface;
  createPresentation(device: GPUDevice, canvas: HTMLCanvasElement): Presentation<HTMLCanvasElement>;
  Renderer: typeof Renderer;
  createFrameLoop: typeof createFrameLoop;
  attachGestures: typeof attachGestures;
  attachKeyboard: typeof attachKeyboard;
  /** The glyph rasterizer the atlas draws with, or null to draw no text. */
  createRasterizer(): Rasterizer | null;
}

const DEFAULT_CONTROLLER_DEPS: ControllerDeps = {
  createSurface,
  createPresentation,
  Renderer,
  createFrameLoop,
  attachGestures,
  attachKeyboard,
  createRasterizer: canvasRasterizer,
};

/**
 * Create a diagram without acquiring a device or a canvas until attach.
 *
 * @param options - Initial rendering and interaction options.
 * @returns A controller for loading netlists, binding channels, and attaching canvases.
 * @throws TypeError or RangeError when any option is invalid, or what the `colormap` throws.
 *
 * @example
 * ```ts
 * const diagram = createDiagram({ interaction: 'edit' });
 * diagram.load(netlist);
 * diagram.on('connect', (wire) => host.propose(wire));
 * await diagram.attach(canvas);
 * ```
 *
 * The controller owns its renderer resources and the device lease it holds while attached, but
 * never the canvas. Detach or destroy the controller before removing its canvas.
 */
export function createDiagram(options: Options = {}): Diagram {
  return createDiagramWithDeps(options, DEFAULT_CONTROLLER_DEPS);
}

/** @internal */
export function createDiagramWithDeps(options: Options, deps: ControllerDeps): Diagram {
  return createDiagramController(resolveOptions(options), deps);
}

/** Least storage buffers the vertex stage must bind: five in bind group 0. */
const VERTEX_STORAGE_BUFFERS = 5;

/** Reject devices known not to meet the renderer's Core WebGPU limits. */
function assertDeviceLimits(device: GPUDevice): void {
  const vertexStorage = device.limits.maxStorageBuffersInVertexStage;
  if (vertexStorage !== undefined && vertexStorage < VERTEX_STORAGE_BUFFERS) {
    throw new TypeError('A Core WebGPU device is required');
  }
}

/** Strip construction-only values from one validated option patch. */
function runtimeOptionPatch(options: Options): Options {
  const patch: Options = {};
  const source = options as Readonly<Record<string, unknown>>;
  const target = patch as Record<string, unknown>;
  for (const [key, definition] of Object.entries(OPTIONS)) {
    if (definition.live && source[key] !== undefined) target[key] = source[key];
  }
  return patch;
}

/** Resources registered transactionally while a binding is constructed. */
interface ControllerLifecycle {
  add(cleanup: () => void): void;
  destroy(): void;
}

/** Create an idempotent, reverse-order cleanup stack. */
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

/** Relay one device-loss notification without retaining a released binding. */
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

/** A promise settled from outside. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A plain wheel: a Ctrl or Meta wheel (a pinch) and a notched wheel zoom; a trackpad pans. */
function zoomingWheel(event: WheelEvent): 'zoom' | 'pan' {
  if (event.ctrlKey || event.metaKey) return 'zoom';
  // A trackpad scrolls in pixels, with horizontal or fractional deltas; a notched wheel does not.
  if (event.deltaMode === 0 && (event.deltaX !== 0 || event.deltaY % 1 !== 0)) return 'pan';
  return 'zoom';
}

/** A wheel that zooms only with Ctrl or Meta held, leaving plain scrolling to the page. */
function modifierWheel(event: WheelEvent): 'zoom' | 'none' {
  return event.ctrlKey || event.metaKey ? 'zoom' : 'none';
}

/** Whether a mode moves the camera: the wheel, a second touch, and drags. */
function navigates(mode: ResolvedOptions['interaction']): boolean {
  return mode === 'edit' || mode === 'navigate';
}

/** Shared allocation-free result for invalid or empty public queries. */
const NO_PARTS: readonly Part[] = Object.freeze([]);
const NO_IDS: readonly number[] = Object.freeze([]);

/** The viewport a detached controller reports: every camera command defers on it. */
const DETACHED_VIEWPORT: Viewport = Object.freeze({ w: 0, h: 0 });

/** The canvas rectangle a detached controller reports. */
const DETACHED_RECT = Object.freeze({ left: 0, top: 0, width: 0, height: 0 });

/** A frame-resolved notice, dropped when a load replaced the scene it was resolved against. */
interface Notice<T> {
  readonly value: T;
  readonly scene: number;
}

/** Everything one attach owns: released together, replaced together. */
interface Binding {
  /** The attach generation that created it; a stale device loss or frame compares against it. */
  readonly generation: number;
  readonly canvas: HTMLCanvasElement;
  readonly surface: Surface;
  readonly renderer: Renderer;
  readonly loop: FrameLoop;
  readonly lifecycle: ControllerLifecycle;
  /** The gesture and keyboard adapters, attached as the `interaction` and `keyboard` options say. */
  gestures: { cancel(): void; destroy(): void } | null;
  keyboard: { destroy(): void } | null;
  /** Whether a frame has been submitted. */
  painted: boolean;
  /** Whether `painted: true` reached the host, so a release answers it with `false`. */
  announced: boolean;
  /** Whether the last frame found the camera at its fit, for `fit` transitions. */
  atFit: boolean;
}

/** Draw counts as the frame fills them. */
type Counts = { -readonly [K in keyof DrawCounts]: DrawCounts[K] };

/** Create the controller: every state lives here, and a binding borrows it for one attach. */
function createDiagramController(initial: ResolvedOptions, deps: ControllerDeps): Diagram {
  let opts = initial;
  const events = createEmitter<Events>();
  const mirrors = createMirrors();
  const uniforms = createUniforms(mirrors.uniforms);
  const channels = createChannels(mirrors.channels, uniforms);
  const scene = new Scene(mirrors, channels);
  const focus = new Focus(mirrors.focus);
  const atlas = new Atlas(deps.createRasterizer(), opts.fontFamily);
  const labels = new Labels(mirrors.glyphs, atlas);
  const camera = new Camera();

  /** The sampled colormap, written into every renderer an attach builds. */
  let colormapLut = bakeColormap(opts.colormap);
  let pipelineFailure: Events['pipelineError'] | null = null;

  let binding: Binding | null = null;
  /** Bumped by every attach, detach, and destroy so an overtaken attach knows to stand down. */
  let generation = 0;
  let destroyed = false;
  let consumerPaused = false;
  let pageVisible = true;
  /** Bumped by every load and grid change; a notice resolved against an older scene is dropped. */
  let sceneGeneration = 0;

  /** The host shade, retained across attaches; the renderer compiles it. */
  let shade: Shade | null = null;
  /** Whether the shade's last tick asked for another frame. */
  let shadeAnimating = false;
  /** The shade compile in flight; a paint request waits for it to settle. */
  let shadeTask: Promise<void> | null = null;
  /** The frame a host awaits; one promise serves every caller until it settles. */
  let paintRequest: Deferred<void> | null = null;

  /** Latest pointer from the canvas or `setPointer`; converted through the current rect per pick. */
  let hoverProbe: { readonly clientX: number; readonly clientY: number; targetPx: number } | null =
    null;
  /** Whether hover must be picked again: the pointer, the view, or the content moved. */
  let hoverDirty = false;
  let pendingHoverNotice: Notice<Part | null> | undefined;
  let readyHoverNotice: Notice<Part | null> | undefined;
  let pendingFitNotice: Notice<boolean> | undefined;
  let readyFitNotice: Notice<boolean> | undefined;
  /** The binding whose first paint awaits announcement. */
  let readyPainted: Binding | null = null;
  let noticeDeliveryQueued = false;

  /** Whether some bound `netFlow` value is nonzero, so dashes march and frames keep coming. */
  let flowing = false;
  /** The scene's `settled` count the glyphs were last generated for. */
  let labelsSettled = -1;
  /** The netlist the uniform counts were last written for. */
  let countsFor: Prepared | null | undefined;

  // The overlay: interactor shapes plus the scene's ghosts, rewritten only when they change.
  let marqueeRect: Rect | null = null;
  let previewPoints: Float32Array | null = null;
  let overlayDirty = false;
  let overlayCount = 0;
  let overlayGhosts = 0;

  // Reused so a frame allocates nothing for them.
  const frameVp: { w: number; h: number } = { w: 0, h: 0 };
  /** The canvas rectangle's size, which hover picks against as every other pick does. */
  const hoverVp: { w: number; h: number } = { w: 0, h: 0 };
  const pointerPx: [number, number] = [0, 0];
  const shadeFrame: { -readonly [K in keyof ShadeFrame]: ShadeFrame[K] } = {
    timeMs: 0,
    pointerPx: null,
    viewport: frameVp,
  };
  const counts: Counts = { groups: 0, wires: 0, blocks: 0, ports: 0, glyphs: 0, overlay: 0 };
  /** Whether a block moved since the last frame drained the scene. */
  let blocksMoved = false;
  // What moved or re-routed means hover must be picked again.
  const blockDrained = (): void => {
    blocksMoved = true;
    hoverDirty = true;
  };
  const netDrained = (): void => {
    hoverDirty = true;
  };
  const ignore = (): void => {};

  /** The reduced-motion media query, read live once asked for. */
  let motionQuery: MediaQueryList | null | undefined;

  /** Whether motion is reduced right now: by option, or by the user's preference under `auto`. */
  function reduced(): boolean {
    if (opts.motion === 'reduce') return true;
    if (opts.motion === 'full') return false;
    motionQuery ??= globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    return motionQuery?.matches === true;
  }
  /** An animation request, honored only when motion is not reduced. */
  const animated = (requested: boolean | undefined): boolean => requested === true && !reduced();

  /** Schedule a frame for a visual state change. */
  const repaint = (): void => binding?.loop.wake();
  /** The view moved: hover must be picked again. */
  const cameraMoved = (): void => {
    hoverDirty = true;
    repaint();
  };
  /** Current canvas viewport in CSS pixels; empty while detached, so camera commands defer. */
  const vp = (): Viewport => (binding ? binding.surface.size() : DETACHED_VIEWPORT);

  /** Fail the awaited frame, cleared first so a request made in reaction is a new one. */
  function rejectPaint(reason: unknown): void {
    const request = paintRequest;
    if (!request) return;
    paintRequest = null;
    request.reject(reason);
  }

  // Parts and anchors.

  /** Whether a part id names a part of `p`. */
  function valid(p: Prepared, id: number): boolean {
    if (id < 0) return false;
    const index = partIndex(id);
    switch (partKind(id)) {
      case PART_BLOCK:
        return index < p.blockCount;
      case PART_PORT:
        return index < p.portCount;
      case PART_NET:
        return index < p.netCount;
      case PART_GROUP:
        return index < p.groupCount;
      default:
        return false;
    }
  }

  /** A port's position in diagram units, or null while its block has none. */
  function portPoint(p: Prepared, port: number): readonly [number, number] | null {
    const positions = scene.positions;
    const block = p.portBlock[port]!;
    const x = positions[2 * block]! + p.portOffset[2 * port]!;
    const y = positions[2 * block + 1]! + p.portOffset[2 * port + 1]!;
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }

  /**
   * A part's anchor in diagram units: a block's center, a port's position, a net's label anchor
   * or else its driver port (else its first port), a group header's center; null when it has none.
   */
  function anchorOf(p: Prepared, id: number): readonly [number, number] | null {
    if (!valid(p, id)) return null;
    const index = partIndex(id);
    const f32 = mirrors.layout.f32;
    switch (partKind(id)) {
      case PART_BLOCK: {
        const positions = scene.positions;
        const x = positions[2 * index]! + p.size[2 * index]! / 2;
        const y = positions[2 * index + 1]! + p.size[2 * index + 1]! / 2;
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
      }
      case PART_PORT:
        return portPoint(p, index);
      case PART_NET: {
        const at = layoutBases(p).anchor + 2 * index;
        const x = f32[at]!;
        const y = f32[at + 1]!;
        if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
        const { netStart, netPorts } = p.netlist;
        const driver = p.netDriver[index]!;
        if (driver !== NONE) return portPoint(p, driver);
        return netStart[index]! < netStart[index + 1]!
          ? portPoint(p, netPorts[netStart[index]!]!)
          : null;
      }
      default: {
        const at = layoutBases(p).group + 4 * index;
        const x = (f32[at]! + f32[at + 2]!) / 2;
        const y = f32[at + 1]! + p.metrics.groupHeader / 2;
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
      }
    }
  }

  /** A part's anchor in canvas-local CSS px within `view`, or null. */
  function screenAnchor(id: number, view: Viewport): readonly [number, number] | null {
    const p = scene.prepared;
    const anchor = p ? anchorOf(p, id) : null;
    if (!anchor || !camera.placed) return null;
    const point = camera.toScreen(anchor[0], anchor[1], view);
    return Number.isFinite(point[0]) && Number.isFinite(point[1]) ? point : null;
  }

  /** The part ids of a neighborhood, beginning with `id`, each once. */
  function neighborsOf(p: Prepared, id: number): number[] {
    const out = [id];
    const seen = new Set(out);
    const add = (next: number): void => {
      if (seen.has(next)) return;
      seen.add(next);
      out.push(next);
    };
    const index = partIndex(id);
    const { netStart, netPorts } = p.netlist;
    switch (partKind(id)) {
      case PART_BLOCK: {
        const from = p.blockNetStart[index]!;
        const to = p.blockNetStart[index + 1]!;
        for (let at = from; at < to; at++) add(partId(PART_NET, p.blockNets[at]!));
        for (let at = from; at < to; at++) {
          const net = p.blockNets[at]!;
          for (let i = netStart[net]!; i < netStart[net + 1]!; i++) {
            add(partId(PART_BLOCK, p.portBlock[netPorts[i]!]!));
          }
        }
        break;
      }
      case PART_PORT: {
        add(partId(PART_BLOCK, p.portBlock[index]!));
        const net = p.portNet[index]!;
        if (net === NONE) break;
        add(partId(PART_NET, net));
        for (let i = netStart[net]!; i < netStart[net + 1]!; i++) {
          add(partId(PART_PORT, netPorts[i]!));
        }
        break;
      }
      case PART_NET:
        for (let i = netStart[index]!; i < netStart[index + 1]!; i++) {
          add(partId(PART_PORT, netPorts[i]!));
        }
        for (let i = netStart[index]!; i < netStart[index + 1]!; i++) {
          add(partId(PART_BLOCK, p.portBlock[netPorts[i]!]!));
        }
        break;
      default:
        for (let at = p.groupStart[index]!; at < p.groupStart[index + 1]!; at++) {
          add(partId(PART_BLOCK, p.groupBlocks[at]!));
        }
    }
    return out;
  }

  /** The blocks whose arrangement units `parts` touch. */
  function blocksOf(p: Prepared, parts: readonly Part[]): Uint32Array {
    const blocks: number[] = [];
    const { netStart, netPorts } = p.netlist;
    for (const part of parts) {
      const id = idOf(part);
      if (!valid(p, id)) continue;
      const index = partIndex(id);
      switch (partKind(id)) {
        case PART_BLOCK:
          blocks.push(index);
          break;
        case PART_PORT:
          blocks.push(p.portBlock[index]!);
          break;
        case PART_NET:
          for (let i = netStart[index]!; i < netStart[index + 1]!; i++) {
            blocks.push(p.portBlock[netPorts[i]!]!);
          }
          break;
        default:
          for (let at = p.groupStart[index]!; at < p.groupStart[index + 1]!; at++) {
            blocks.push(p.groupBlocks[at]!);
          }
      }
    }
    return Uint32Array.from(blocks);
  }

  /** Part ids under a canvas-local point, in priority order; `radiusPx` in CSS px. */
  function pickAt(sx: number, sy: number, radiusPx: number, view: Viewport): readonly number[] {
    if (!scene.prepared || !camera.placed) return NO_IDS;
    const [x, y] = camera.toDiagram(sx, sy, view);
    return scene.picker.pick(x, y, radiusPx / camera.pose.zoom);
  }

  // Camera commands shared by the API and the gestures.

  /** Fit every visible part; deferred until a viewport has area. */
  function fitAll(animate: boolean): void {
    if (!scene.prepared) return;
    const bounds = scene.bounds();
    if (!bounds) return;
    // The zoom limits follow the content as it is now, not as it was loaded.
    if (camera.placed) camera.setBounds(bounds, false);
    camera.fit(bounds, vp(), opts.fitPaddingPx, animated(animate), opts.animationMs);
    cameraMoved();
  }

  // Hover.

  /** Hover a part id or nothing, and stage a notice for the frame that shows it. */
  function applyHover(id: number | null): boolean {
    if (!focus.setHover(id)) return false;
    pendingHoverNotice = { value: id === null ? null : partOf(id), scene: sceneGeneration };
    return true;
  }

  /**
   * Pick the latest probe once nothing moves under it: not while a drag or navigation is in
   * flight, a resize settles, the camera eases, or an arrangement moves blocks this frame. Ghosts
   * fading hold nothing up: they are not pickable.
   */
  function resolveHover(bound: Binding, sizeSettled: boolean): void {
    const probe = hoverProbe;
    if (!probe || !scene.prepared) return;
    const easing = scene.animating && blocksMoved;
    if (interactor.active || !sizeSettled || camera.animating || easing) {
      hoverDirty = true;
      return;
    }
    if (!hoverDirty) return;
    hoverDirty = false;
    const rect = bound.surface.rect();
    const sx = probe.clientX - rect.left;
    const sy = probe.clientY - rect.top;
    let hit: number | null = null;
    if (sx >= 0 && sy >= 0 && sx < rect.width && sy < rect.height) {
      // The rect's size, not the frame's content box: a point measured from the rect's corner
      // maps through the rect's center, as taps and `hitTest` map it, padding and border or not.
      hoverVp.w = rect.width;
      hoverVp.h = rect.height;
      hit = pickAt(sx, sy, probe.targetPx, hoverVp)[0] ?? null;
    }
    applyHover(hit);
  }

  /** Forget the pointer and clear hover at once, off the frame path, for a surface gone inactive. */
  function dropHover(): void {
    hoverProbe = null;
    hoverDirty = false;
    pendingHoverNotice = undefined;
    readyHoverNotice = undefined;
    if (focus.setHover(null)) {
      events.emit('hover', null);
      repaint();
    }
  }

  /**
   * Clear hover for a scene that changed under it: the next frame picks the pointer again, and
   * says so when nothing lies there now.
   */
  function sceneReplaced(hovered: boolean): void {
    sceneGeneration++;
    pendingHoverNotice = hovered ? { value: null, scene: sceneGeneration } : undefined;
    readyHoverNotice = undefined;
    pendingFitNotice = undefined;
    readyFitNotice = undefined;
    // A new scene reports every block and net; none of them is moving.
    scene.drain(ignore, ignore);
    hoverDirty = true;
  }

  // Input.

  /** Every gesture: hover probes stay here, everything else goes through the interactor. */
  function onGesture(gesture: Gesture): void {
    if (!binding) return;
    switch (gesture.kind) {
      case 'hover':
        hoverProbe = {
          clientX: gesture.clientX,
          clientY: gesture.clientY,
          targetPx: gesture.targetPx,
        };
        hoverDirty = true;
        repaint();
        return;
      case 'hoverEnd':
        hoverProbe = null;
        hoverDirty = false;
        if (applyHover(null)) repaint();
        return;
      default:
        interactor.gesture(gesture);
        // A wheel or pinch came to rest: nothing else may schedule a frame, and the part under
        // the resting pointer must be picked again.
        if (gesture.kind === 'navigationEnd') {
          hoverDirty = true;
          repaint();
        }
    }
  }

  /** Every key: the interactor says whether it used it; an Escape that cancels ends the drag too. */
  function onKey(intent: KeyIntent): boolean {
    const bound = binding;
    // An adapter going away releases a held Space, on a detach after the binding is gone; the
    // interactor must still hear it, or every later drag in `edit` pans.
    if (!bound) return intent.kind === 'space' && !intent.down && interactor.key(intent);
    // Only a pointer drag has an adapter drag to end: an Escape that merely clears the selection
    // during a wheel or pinch must leave a pending mouse press to become its tap or drag.
    const dragging = interactor.dragging;
    const used = interactor.key(intent);
    // After the interactor aborted, the adapter's trailing cancelled dragEnd finds nothing to end.
    if (intent.kind === 'escape' && dragging && used) bound.gestures?.cancel();
    return used;
  }

  const context: InteractionContext = {
    mode: () => opts.interaction,
    snap: () => opts.snap,
    reduced,
    prepared: () => scene.prepared,
    toDiagram: (sx, sy) => camera.toDiagram(sx, sy, vp()),
    zoom: () => camera.pose.zoom,
    viewport: vp,
    rect: () => (binding ? binding.surface.rect() : DETACHED_RECT),
    pickRadiusPx: () => opts.pickRadiusPx,
    pick: (sx, sy, radiusPx) => pickAt(sx, sy, radiusPx, vp()),
    locate: (id) => screenAnchor(id, vp()),
    marquee: (x0, y0, x1, y1) => scene.picker.marquee(x0, y0, x1, y1),
    target: (from, replaces, x, y, radius) => scene.picker.target(from, replaces, x, y, radius),
    compatible: (from, replaces) => scene.picker.compatible(from, replaces),
    scene,
    focus,
    camera: {
      panBy(dx, dy) {
        if (camera.panBy(dx, dy)) cameraMoved();
      },
      zoomAt(factor, sx, sy) {
        if (camera.zoomAt(factor, sx, sy, vp())) cameraMoved();
      },
      fit() {
        fitAll(true);
      },
    },
    overlay: {
      marquee(rect) {
        marqueeRect = rect;
        overlayDirty = true;
      },
      preview(points) {
        previewPoints = points;
        overlayDirty = true;
      },
    },
    previewRoute(from, x, y, target) {
      const p = scene.prepared;
      return p
        ? routePreview(p, scene.positions, from, x, y, target, scene.laneShift)
        : new Float32Array(0);
    },
    detach: (port) => scene.detach(port),
    emit(event, payload) {
      if (event === 'hover') {
        // A drag cleared hover: a notice resolved before it is stale, and the pointer is picked
        // again once the drag ends.
        pendingHoverNotice = undefined;
        readyHoverNotice = undefined;
        hoverDirty = true;
      }
      events.emit(event, payload);
    },
    repaint,
  };
  const interactor = new Interactor(context);

  // Options.

  /** Apply what changed between `previous` and `opts`, the colormap already sampled. */
  function applyOptions(previous: ResolvedOptions, lut: Uint8Array | null): void {
    if (lut) {
      colormapLut = lut;
      binding?.renderer.writeColormap(lut);
    }
    uniforms.setColors(opts);
    if (opts.gridPitch !== previous.gridPitch) regrid();
    if (opts.routing !== previous.routing) scene.setRouting(opts.routing);
    if (opts.fontFamily !== previous.fontFamily) atlas.setFont(opts.fontFamily);
    if (opts.fitPaddingPx !== previous.fitPaddingPx) camera.setPadding(opts.fitPaddingPx);
    scene.animationMs = opts.animationMs;
    scene.motion = !reduced();
    if (opts.interaction !== previous.interaction) interactor.cancel();
    syncInteraction();
    hoverDirty = true;
  }

  /** Re-size and re-arrange at the grid pitch in effect; indices hold, so focus remaps to itself. */
  function regrid(): void {
    interactor.cancel();
    const before = scene.prepared;
    const atFit = camera.isAtFit();
    const hovered = focus.hover !== null;
    scene.setGrid(opts.gridPitch);
    const after = scene.prepared;
    if (!before || !after || after === before) return;
    const identity = new Uint32Array(after.blockCount);
    for (let block = 0; block < identity.length; block++) identity[block] = block;
    focus.remap(before, after, identity);
    labels.reset(after);
    sceneReplaced(hovered);
    camera.setBounds(scene.bounds(), atFit);
  }

  /**
   * Follow the live `interaction` and `keyboard` options: which adapters listen, and whether
   * touch belongs to the camera or the page.
   */
  function syncInteraction(): void {
    const entry = binding;
    if (!entry) return;
    const mode = opts.interaction;
    entry.surface.setNavigable(navigates(mode));
    if (mode !== 'none' && !entry.gestures) {
      entry.gestures = deps.attachGestures(entry.surface, onGesture, {
        wheel: (event) => (opts.wheel === 'zoom' ? zoomingWheel(event) : modifierWheel(event)),
        pickRadiusPx: () => opts.pickRadiusPx,
        navigable: () => navigates(opts.interaction),
      });
    } else if (mode === 'none' && entry.gestures) {
      // Destroying the adapter resets any gesture; the pointer it reported is gone with it.
      entry.gestures.destroy();
      entry.gestures = null;
      hoverProbe = null;
      hoverDirty = false;
      if (applyHover(null)) repaint();
    }
    const keys = opts.keyboard && mode !== 'none';
    if (keys && !entry.keyboard) {
      entry.keyboard = deps.attachKeyboard(entry.canvas, onKey);
    } else if (!keys && entry.keyboard) {
      entry.keyboard.destroy();
      entry.keyboard = null;
    }
  }

  // The frame.

  /**
   * Write one overlay entry, growing the mirror as needed; `along` is a preview leg's distance
   * from the route's start in diagram units, 0 for every other kind.
   */
  function putOverlay(
    kind: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    alpha: number,
    along: number,
  ): void {
    const mirror = mirrors.overlay;
    const at = overlayCount * OVERLAY_WORDS;
    mirror.resize(at + OVERLAY_WORDS);
    const { f32, u32 } = mirror;
    u32[at] = kind;
    f32[at + 1] = x0;
    f32[at + 2] = y0;
    f32[at + 3] = x1;
    f32[at + 4] = y1;
    f32[at + 5] = alpha;
    f32[at + OVERLAY_ALONG] = along;
    u32[at + 7] = 0;
    overlayCount++;
  }
  const putGhost = (x0: number, y0: number, x1: number, y1: number, alpha: number): void => {
    putOverlay(OVERLAY_GHOST, x0, y0, x1, y1, alpha, 0);
    overlayGhosts++;
  };

  /** Rewrite the overlay when its shapes changed or ghosts fade: marquee, preview, ghosts. */
  function writeOverlay(): void {
    if (!overlayDirty && overlayGhosts === 0 && !scene.animating) return;
    overlayDirty = false;
    overlayCount = 0;
    overlayGhosts = 0;
    const r = marqueeRect;
    if (r) putOverlay(OVERLAY_MARQUEE, r[0], r[1], r[2], r[3], 1, 0);
    const points = previewPoints;
    if (points) {
      // Each leg carries the length before it, so the dashes run on around every bend.
      let along = 0;
      for (let i = 2; i + 1 < points.length; i += 2) {
        const x0 = points[i - 2]!;
        const y0 = points[i - 1]!;
        const x1 = points[i]!;
        const y1 = points[i + 1]!;
        putOverlay(OVERLAY_PREVIEW, x0, y0, x1, y1, 1, along);
        along += Math.hypot(x1 - x0, y1 - y0);
      }
    }
    scene.overlayGhosts(putGhost);
    const words = overlayCount * OVERLAY_WORDS;
    mirrors.overlay.resize(words);
    mirrors.overlay.touch(0, words);
  }

  /** The pointer in canvas-local CSS px, or null; reused, valid for this frame. */
  function pointerOf(surface: Surface): readonly [number, number] | null {
    if (!hoverProbe) return null;
    const rect = surface.rect();
    pointerPx[0] = hoverProbe.clientX - rect.left;
    pointerPx[1] = hoverProbe.clientY - rect.top;
    return pointerPx;
  }

  /**
   * One frame: camera, arrangement tweens and ghosts, auto-pan, hover, the host shade, uniforms,
   * overlay, text, submit. Returns whether anything still moves: camera easing, scene tweens or
   * ghosts, auto-pan, the shade's tick, a pulsing glow, or marching dashes.
   */
  function drawFrame(own: number, frame: Frame): boolean {
    const bound = binding;
    if (!bound || bound.generation !== own || consumerPaused || !pageVisible) return false;
    const now = frame.now;
    frameVp.w = frame.width;
    frameVp.h = frame.height;
    const motion = !reduced();
    scene.motion = motion;

    camera.tick(now, frameVp);
    if (camera.placed) {
      const atFit = camera.isAtFit();
      if (atFit !== bound.atFit) {
        bound.atFit = atFit;
        pendingFitNotice = { value: atFit, scene: sceneGeneration };
      }
    }
    scene.tick(now);
    const panning = interactor.tick(now);
    // The picker is already current; the drain says what moved under the pointer.
    blocksMoved = false;
    scene.drain(blockDrained, netDrained);
    const settled = scene.settled;
    const force = settled !== labelsSettled;
    labelsSettled = settled;
    resolveHover(bound, frame.settled);

    const pointer = pointerOf(bound.surface);
    if (shade?.tick) {
      shadeFrame.timeMs = now;
      shadeFrame.pointerPx = pointer;
      shadeAnimating = shade.tick(uniforms.host, shadeFrame) === true;
      // The shade's tick is host code: a pause, detach, or destroy from it ends the frame.
      if (binding !== bound || consumerPaused || !pageVisible) return false;
    } else {
      shadeAnimating = false;
    }

    const p = scene.prepared;
    if (countsFor !== p) {
      uniforms.setCounts(p);
      countsFor = p;
    }
    const pose = camera.pose;
    uniforms.setFrame(frame.width, frame.height, frame.backingScale, now);
    uniforms.setCamera(pose.centerX, pose.centerY, pose.zoom);
    uniforms.setPointer(pointer);
    uniforms.flags =
      (opts.grid && camera.placed ? DISPLAY_GRID : 0) |
      (opts.arrows ? DISPLAY_ARROWS : 0) |
      (opts.junctions ? DISPLAY_JUNCTIONS : 0) |
      (opts.labels ? DISPLAY_LABELS : 0) |
      (motion ? 0 : DISPLAY_REDUCED) |
      (opts.interaction === 'edit' ? DISPLAY_EDIT : 0);
    uniforms.gridPitch = p?.metrics.grid ?? opts.gridPitch;
    uniforms.flowRate = opts.flowRate;
    writeOverlay();

    counts.groups = p?.groupCount ?? 0;
    counts.wires = scene.routes.capacity;
    counts.blocks = p?.blockCount ?? 0;
    counts.ports = p?.portCount ?? 0;
    counts.glyphs = labels.update(
      camera.view(frameVp),
      pose.zoom,
      mirrors.layout,
      opts.labels,
      force,
    );
    // After the text: rasterizing it may grow the atlas, and the glyph pass samples by this size.
    uniforms.setAtlas(atlas);
    counts.overlay = overlayCount;
    if (bound.renderer.render(counts, atlas)) onSuccessfulPaint(bound);

    return (
      camera.animating ||
      scene.animating ||
      panning ||
      shadeAnimating ||
      (motion && (focus.glowing || (flowing && opts.flowRate > 0)))
    );
  }

  /** Whether a load waits for a viewport to place its camera. */
  const placementPending = (): boolean => scene.prepared !== null && !camera.placed;

  /**
   * Settle what a submitted frame shows: the awaited paint, and the notices it resolved, which
   * reach the host in a microtask so no handler runs inside the frame.
   */
  function onSuccessfulPaint(bound: Binding): void {
    // Cleared before any host event fires: a request a listener makes belongs to the next frame.
    if (paintRequest && !placementPending() && !shadeTask) {
      const request = paintRequest;
      paintRequest = null;
      request.resolve();
    }
    let promoted = false;
    if (!bound.painted) {
      bound.painted = true;
      readyPainted = bound;
      promoted = true;
    }
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
    queueMicrotask(deliverNotices);
  }

  /** Deliver the notices submitted frames resolved: first paint, then fit, then hover. */
  function deliverNotices(): void {
    noticeDeliveryQueued = false;
    const painted = readyPainted;
    const fitNotice = readyFitNotice;
    const hoverNotice = readyHoverNotice;
    readyPainted = null;
    readyFitNotice = undefined;
    readyHoverNotice = undefined;
    if (destroyed) return;
    if (painted && binding === painted && !painted.announced) {
      painted.announced = true;
      events.emit('painted', true);
    }
    // A fit listener may load; the scene check then drops the stale hover.
    if (fitNotice?.scene === sceneGeneration) events.emit('fit', fitNotice.value);
    if (hoverNotice?.scene === sceneGeneration) events.emit('hover', hoverNotice.value);
  }

  // Binding.

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
      // A new renderer's buffers start at version -1: its first frame uploads every mirror.
      const renderer = new deps.Renderer(presentation, mirrors, shade?.wgsl ?? null);
      lifecycle.add(() => renderer.destroy());
      renderer.writeColormap(colormapLut);
      const loop = deps.createFrameLoop(presentation, (frame) => drawFrame(own, frame));
      lifecycle.add(() => loop.destroy());

      // A fresh renderer builds fresh pipelines; a failure from the last one no longer applies.
      pipelineFailure = null;
      renderer.onPipelinesReady = () => loop.wake();
      renderer.onPipelineError = (cause) => {
        pipelineFailure = { cause };
        rejectPaint(cause);
        events.emit('pipelineError', pipelineFailure);
      };

      pageVisible = typeof document !== 'undefined' ? !document.hidden : true;
      const onVisibilityChange = (): void => {
        pageVisible = !document.hidden;
        syncLoopActivity();
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
        gestures: null,
        keyboard: null,
        painted: false,
        announced: false,
        atFit: true,
      };
      lifecycle.add(() => {
        entry.gestures?.destroy();
        entry.gestures = null;
        entry.keyboard?.destroy();
        entry.keyboard = null;
      });
      return entry;
    } catch (error) {
      lifecycle.destroy();
      throw error;
    }
  }

  /** Release the current binding, if any, and say so. */
  function release(): void {
    const entry = binding;
    if (!entry) return;
    binding = null;
    shadeTask = null;
    rejectPaint(new DOMException('The canvas was detached before it painted.', 'AbortError'));
    interactor.cancel();
    hoverProbe = null;
    hoverDirty = false;
    pendingHoverNotice = undefined;
    readyHoverNotice = undefined;
    pendingFitNotice = undefined;
    readyFitNotice = undefined;
    readyPainted = null;
    focus.setHover(null);
    shadeAnimating = false;
    entry.lifecycle.destroy();
    if (destroyed) return;
    if (entry.announced) events.emit('painted', false);
    events.emit('attached', false);
  }

  /**
   * A device the platform lost: release it, say so, and lease a replacement, unless a host
   * handler detached or attached anew meanwhile; that call owns the canvas then.
   */
  function recover(own: number, info: GPUDeviceLostInfo): void {
    const entry = binding;
    if (!entry || entry.generation !== own || destroyed) return;
    const { canvas } = entry;
    // A detach or attach bumps the generation; the `attached` and `deviceLost` handlers may call
    // either, and the host's call must win.
    const mark = generation;
    release();
    events.emit('deviceLost', {
      reason: info.reason ?? 'unknown',
      message: info.message || 'WebGPU device was lost',
      recovering: generation === mark && !destroyed,
    });
    if (generation !== mark || destroyed) return;
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

  /** Keep loop activity consistent with user pause and page visibility. */
  function syncLoopActivity(): void {
    const loop = binding?.loop;
    if (!loop) return;
    if (!consumerPaused && pageVisible) loop.resume();
    else loop.pause();
  }

  /** Recompute whether any bound `netFlow` value is nonzero. */
  function refreshFlow(): void {
    const values = channels.values('netFlow');
    flowing = false;
    if (!values) return;
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      if (value !== 0 && !Number.isNaN(value)) {
        flowing = true;
        return;
      }
    }
  }

  // Construction-time state the options carry.
  uniforms.setColors(opts);
  camera.setPadding(opts.fitPaddingPx);
  scene.animationMs = opts.animationMs;
  scene.setRouting(opts.routing);

  /** Public controller facade; every change is a repaint away from the canvas. */
  const api: Diagram = {
    get attached() {
      return binding !== null;
    },

    get painted() {
      return binding?.painted ?? false;
    },

    on(event, handler) {
      const unsubscribe = events.on(event, handler);
      if (event === 'pipelineError' && pipelineFailure) {
        replay(handler as (payload: Events['pipelineError']) => void, pipelineFailure);
      }
      return unsubscribe;
    },

    async attach(canvas) {
      if (destroyed) throw new Error('diagram: the controller is destroyed');
      const own = ++generation;
      release();
      const lease = await opts.devices.acquire();
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
        syncInteraction();
        syncLoopActivity();
        entry.loop.frameNow();
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

    paint() {
      if (!binding) {
        return Promise.reject(
          new DOMException('The diagram is not attached.', 'InvalidStateError'),
        );
      }
      const { promise } = (paintRequest ??= deferred());
      if (pipelineFailure) rejectPaint(pipelineFailure.cause);
      else repaint();
      return promise;
    },

    load(netlist, { fit = true } = {}) {
      const prev = scene.prepared;
      if (prev && sameNetlist(prev.netlist, netlist)) return;
      validateNetlist(netlist);
      // Drag indices name the old netlist.
      interactor.cancel();
      const hovered = focus.hover !== null;
      const survivors = scene.load(netlist, opts.gridPitch, !reduced(), performance.now());
      const next = scene.prepared!;
      if (prev) focus.remap(prev, next, survivors);
      else focus.reset(next);
      labels.reset(next);
      refreshFlow();
      sceneReplaced(hovered);
      // Null bounds (nothing shown) keep the camera placed: an empty diagram still maps points.
      camera.setBounds(scene.bounds(), fit);
      // A wake, not a frame now: a host re-binds channels (its own placements above all) right
      // after a load, and they belong in the same frame, or every edit flashes blocks elsewhere.
      repaint();
    },

    setOptions(patch) {
      validateOptions(patch);
      const live = runtimeOptionPatch(patch);
      if (Object.keys(live).length === 0) return;
      // Caller code may throw: the colormap is sampled before anything is applied.
      const lut = live.colormap ? bakeColormap(live.colormap) : null;
      const previous = opts;
      opts = resolveOptions(live, previous);
      applyOptions(previous, lut);
      repaint();
    },

    setChannel(channel, values, domain) {
      if (values === null) channels.clear(channel);
      else channels.set(channel, values, domain);
      switch (channel) {
        case 'blockPosition':
          scene.placementChanged();
          hoverDirty = true;
          break;
        case 'blockVisible':
        case 'netVisible':
          scene.visibilityChanged();
          hoverDirty = true;
          break;
        case 'netFlow':
          refreshFlow();
          break;
        default:
          break;
      }
      repaint();
    },

    setChannelDomain(channel, domain) {
      channels.setDomain(channel, domain);
      repaint();
    },

    getChannelDomain(channel) {
      return channels.domain(channel);
    },

    arrange(parts, { animate = false } = {}) {
      const p = scene.prepared;
      if (!p) return new Float32Array(0);
      const blocks = parts === undefined ? null : blocksOf(p, parts);
      const positions = scene.arrange(blocks, animated(animate), performance.now());
      hoverDirty = true;
      repaint();
      return positions;
    },

    select(parts) {
      const ids: number[] = [];
      for (const part of parts) {
        const id = idOf(part);
        if (id >= 0) ids.push(id);
      }
      if (focus.select(ids)) repaint();
    },

    hitTest(clientX, clientY, radiusPx = opts.pickRadiusPx) {
      const bound = binding;
      if (
        !bound ||
        !Number.isFinite(clientX) ||
        !Number.isFinite(clientY) ||
        !Number.isFinite(radiusPx) ||
        radiusPx < 0
      ) {
        return NO_PARTS;
      }
      const rect = bound.surface.rect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      if (sx < 0 || sy < 0 || sx >= rect.width || sy >= rect.height) return NO_PARTS;
      const radius = Math.min(radiusPx, Math.hypot(rect.width, rect.height));
      const ids = pickAt(sx, sy, radius, { w: rect.width, h: rect.height });
      return ids.length === 0 ? NO_PARTS : ids.map(partOf);
    },

    locate(part) {
      const bound = binding;
      if (!bound) return null;
      const rect = bound.surface.rect();
      const point = screenAnchor(idOf(part), { w: rect.width, h: rect.height });
      return point ? [point[0] + rect.left, point[1] + rect.top] : null;
    },

    neighborhood(part) {
      const p = scene.prepared;
      const id = idOf(part);
      if (!p || !valid(p, id)) return NO_PARTS;
      return neighborsOf(p, id).map(partOf);
    },

    reveal(part, { neighbors = false, animate = false } = {}) {
      const p = scene.prepared;
      const id = idOf(part);
      if (!p || !valid(p, id)) return false;
      const parts = neighbors ? neighborsOf(p, id).map(partOf) : [partOf(id)];
      const bounds = scene.boundsOf(parts);
      if (!bounds) return false;
      const view = vp();
      if (parts.length > 1) {
        camera.moveTo(bounds, view, animated(animate), opts.animationMs);
        cameraMoved();
        return true;
      }
      const at = view.w > 0 && view.h > 0 ? screenAnchor(id, view) : null;
      if (at) {
        const inset = Math.min(
          opts.revealPaddingPx,
          Math.max(0, (Math.min(view.w, view.h) - 2) / 2),
        );
        const [x, y] = at;
        if (x >= inset && x <= view.w - inset && y >= inset && y <= view.h - inset) {
          // In view now: a move still in flight would carry it off, so it stops here.
          if (camera.claim()) cameraMoved();
          return true;
        }
      }
      const centerX = (bounds[0] + bounds[2]) / 2;
      const centerY = (bounds[1] + bounds[3]) / 2;
      if (camera.setPose({ centerX, centerY }, animated(animate), opts.animationMs)) cameraMoved();
      return true;
    },

    fit(partsOrAnimate: readonly Part[] | boolean = false, animate: boolean = false) {
      if (typeof partsOrAnimate === 'boolean') {
        fitAll(partsOrAnimate);
        return;
      }
      if (!scene.prepared) return;
      const bounds = scene.boundsOf(partsOrAnimate);
      if (!bounds) return;
      // Framing a subset leaves the fit view as `fit()` defined it.
      camera.moveTo(bounds, vp(), animated(animate), opts.animationMs);
      cameraMoved();
    },

    toDiagram(clientX, clientY) {
      const bound = binding;
      if (!bound || !camera.placed) return null;
      const rect = bound.surface.rect();
      const [x, y] = camera.toDiagram(clientX - rect.left, clientY - rect.top, {
        w: rect.width,
        h: rect.height,
      });
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (!opts.snap) return [x, y];
      const grid = scene.prepared?.metrics.grid ?? opts.gridPitch;
      return [snapTo(x, grid), snapTo(y, grid)];
    },

    getPose() {
      if (!scene.prepared || !camera.placed) return null;
      return camera.pose;
    },

    setPose(pose, animate = false) {
      if (!scene.prepared) return false;
      if (!camera.setPose(pose, animated(animate), opts.animationMs)) return false;
      cameraMoved();
      return true;
    },

    panBy(dx, dy) {
      if (!scene.prepared) return;
      if (camera.panBy(dx, dy)) cameraMoved();
    },

    zoomBy(factor) {
      if (!scene.prepared) return;
      const view = vp();
      if (camera.zoomAt(factor, view.w / 2, view.h / 2, view)) cameraMoved();
    },

    setPointer(clientX: number | null, clientY?: number) {
      // The public form of the hover gesture: one probe, one pick, one uniform.
      if (clientX === null) {
        onGesture({ kind: 'hoverEnd' });
      } else if (Number.isFinite(clientX) && clientY !== undefined && Number.isFinite(clientY)) {
        onGesture({ kind: 'hover', clientX, clientY, targetPx: opts.pickRadiusPx });
      }
    },

    setShade(next) {
      const previous = shade;
      shade = next;
      uniforms.host.fill(0);
      shadeAnimating = false;
      const bound = binding;
      if (!bound) return Promise.resolve();
      const task: Promise<void> = bound.renderer.setShade(next?.wgsl ?? null).then(
        () => {
          if (shadeTask === task) shadeTask = null;
          if (binding !== bound) return;
          // The renderer dropped a failed build along with the old shade.
          pipelineFailure = null;
          bound.loop.wake();
        },
        (error: unknown) => {
          // A rejected shade rolls back; the retained one paints the next frame.
          if (shadeTask === task) shadeTask = null;
          if (shade === next) shade = previous;
          repaint();
          throw error;
        },
      );
      shadeTask = task;
      return task;
    },

    pause() {
      consumerPaused = true;
      syncLoopActivity();
      dropHover();
    },

    resume() {
      consumerPaused = false;
      syncLoopActivity();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      release();
      interactor.cancel();
      pendingHoverNotice = undefined;
      readyHoverNotice = undefined;
      pendingFitNotice = undefined;
      readyFitNotice = undefined;
      shade = null;
      hoverProbe = null;
      marqueeRect = null;
      previewPoints = null;
      overlayCount = 0;
      overlayGhosts = 0;
      mirrors.overlay.release();
      countsFor = undefined;
      flowing = false;
      // Forget the netlist and everything derived from it, down to the glyphs; every mirror but
      // the fixed-size uniforms gives its memory back.
      scene.clear();
      focus.reset(null);
      labels.reset(null);
      channels.reset(null);
      atlas.setFont(opts.fontFamily);
      camera.reset();
      events.clear();
    },
  };

  return api;
}
