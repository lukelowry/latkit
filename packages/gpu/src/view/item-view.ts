import { failure, type Data } from '@latkit/model';
import type { Gpu } from '../gpu.js';
import type { FrameInfo, Preparation, Viewport } from '../frame/render.js';
import { defaultShade, type Shade } from '../style/shade.js';
import {
  createCanvasInput,
  inputModifiers,
  wheelDelta,
  withinBudget,
  type CanvasInput,
  type ContextMenu,
  type HoverState,
  type Modifiers,
} from './input.js';
import { resolveViewStyle, viewStyle, type ResolvedViewStyle, type ViewStyle } from './style.js';
import {
  BaseView,
  type ConfigShape,
  type Point,
  type SetOptions,
  type View,
  type ViewConfig,
  type ViewEvents,
  type ViewStats,
} from './view.js';

export interface ViewInput {
  /**
   * `navigate` moves the camera; `inspect` only hovers, selects, and opens menus; `edit`, where a
   * view supports it, also changes the data.
   */
  readonly mode?: 'navigate' | 'inspect' | 'edit' | 'none';
  /** Zoom on every wheel, or only with Ctrl or ⌘. */
  readonly wheel?: 'zoom' | 'modifier';
  readonly keyboard?: boolean;
}
export interface ViewCamera {
  /** Keep the data in view as it changes. Moving a framed key turns it off. */
  readonly fit: boolean;
}
export interface ItemViewConfig extends ViewConfig, ViewStyle {
  /** Borrowed: destroy never closes it. */
  readonly source: Data;
  readonly input?: ViewInput | NonNullable<ViewInput['mode']>;
  /** WGSL that recolors every fragment. */
  readonly shade?: Shade | null;
}
export interface ItemEvents<Item, Hit, Camera> extends ViewEvents {
  /** The drawn camera changed. */
  readonly camera: Camera;
  /** The item under the pointer. */
  readonly hover: Hit | null;
  /** The user changed the selection, or a source change removed selected items. */
  readonly select: readonly Item[];
  /** Double click on an item, or Enter on the selection. */
  readonly open: Item;
  readonly contextmenu: ContextMenu<Hit>;
}
export interface PickOptions {
  readonly radiusPx?: number;
  /** At most this many hits; 16 by default. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
/** A view of model rows. `Item` is what you select; `Hit` is what a pointer finds: an Item with detail. */
export interface ItemView<
  Config extends ItemViewConfig,
  Item,
  Hit extends Item,
  Camera extends ViewCamera,
  Events extends ItemEvents<Item, Hit, Camera> = ItemEvents<Item, Hit, Camera>,
> extends View<Config, Events> {
  /** Where the camera is going. `set({ camera })` moves it. */
  readonly camera: Camera;
  readonly selection: readonly Item[];
  /** Replace the selection without reporting it. */
  select(items: readonly Item[]): void;
  /** Hits near a canvas point: nearest first, topmost breaking ties. */
  pick(point: Point, options?: PickOptions): Promise<readonly Hit[]>;
  /** An item's canvas point in the latest frame, or null when it is not drawn. */
  locate(item: Item): Point | null;
  /** Frame the items once, or follow all the data. */
  fit(items?: readonly Item[], options?: SetOptions): void;
  /** Center an item that lies outside the padded view. */
  reveal(item: Item, options?: SetOptions): void;
}

type Mode = NonNullable<ViewInput['mode']>;
/** What an item view is, fixed when it is created. */
export interface ItemShape<Camera> extends ConfigShape {
  /** The view's name in messages, such as `network`. */
  readonly name: string;
  /** Camera keys that framing sets; moving one by hand stops fitting. */
  readonly framed: readonly (keyof Camera)[];
  /** Input modes the view supports, its default first: `navigate`, `inspect`, and `none` by default. */
  readonly modes?: readonly Mode[];
  /** The view's own defaults for the shared style. */
  readonly style?: Partial<ResolvedViewStyle>;
  /** The view's own options, beside the shared ones and its records and merged options. */
  readonly options?: readonly string[];
  /** Whether a click selects what it hits; a view with its own press gestures selects itself. */
  readonly clicks?: boolean;
}
/** The framed camera keys that show these items, or all the data; undefined until there is data. */
export type Framing<Item, Camera> = (
  items: readonly Item[] | undefined,
  camera: Camera,
  viewport: Viewport,
) => Partial<Camera> | undefined | Promise<Partial<Camera> | undefined>;
/** A hover search. Synchronous searches call `check`; asynchronous ones observe `signal`. */
export type HoverSearch<Hit> = (
  point: Point,
  radiusPx: number,
  options: { readonly check: () => void; readonly signal: AbortSignal },
) => Hit | null | Promise<Hit | null>;

/**
 * Limits over their defaults. Every limit is positive; counts and bytes are whole, and durations,
 * named in `Ms`, may be fractional. Unknown limits throw.
 */
export function resolveLimits<K extends string>(
  given: Partial<Readonly<Record<K, number>>> | undefined,
  defaults: Readonly<Record<K, number>>,
  name: string,
): Readonly<Record<K, number>> {
  const result: Record<string, number> = { ...defaults };
  for (const [key, value] of Object.entries(given ?? {})) {
    if (!Object.hasOwn(defaults, key))
      throw failure('invalid-input', `Unknown ${name} limit: ${key}`);
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !(value > 0) ||
      !Number.isFinite(value) ||
      (!key.endsWith('Ms') && !Number.isSafeInteger(value))
    )
      throw failure('invalid-input', `Invalid ${name} limit: ${key}`);
    result[key] = value;
  }
  return Object.freeze(result) as Readonly<Record<K, number>>;
}

interface Hovered<Hit> {
  readonly item: Hit | null;
  readonly state: HoverState;
  readonly pointer: number;
  readonly ms: number;
  /** False while an asynchronous search is still running; its result publishes itself. */
  readonly final: boolean;
}
interface Drawn<Camera, Hit> {
  camera: Camera;
  readonly version: number;
  readonly animation?: Animation<Camera>;
  readonly finished: boolean;
  readonly viewport: Viewport;
  hover?: Hovered<Hit>;
}
interface Animation<Camera> {
  readonly from: Camera;
  readonly duration: number;
  start?: number;
}
const MODES: readonly Mode[] = ['navigate', 'inspect', 'none'];
const INPUT = new Set(['mode', 'wheel', 'keyboard']);
/** Options every item view takes, beside the shared style. */
const OPTIONS = ['canvas', 'at', 'paused', 'source', 'camera', 'input', 'shade'];
/** Hover waits this long after the camera, positions, or data move. */
const SETTLE_MS = 150;
/** A press that moves farther than this is a drag, not a click. */
const CLICK_PX = 4;
/** A touch picks at least this far around itself, about a fingertip. */
const TOUCH_PX = 22;
/** Pipeline variants a view kind keeps per Gpu: formats, MSAA, and shades in use. */
const VARIANTS = 8;
/** Pipelines by Gpu and view kind, so views of one kind share each variant. */
const variants = new WeakMap<Gpu, WeakMap<object, Map<string, Promise<unknown>>>>();

/**
 * The base of every item view. The camera, selection, picking, hover, clicks, events, input,
 * shades, pipeline variants, and option checks live here once; a view supplies its geometry, what
 * its config resolves to, and the frames it prepares.
 */
export abstract class BaseItemView<
  Config extends ItemViewConfig,
  Item,
  Hit extends Item,
  Camera extends ViewCamera,
  Events extends ItemEvents<Item, Hit, Camera>,
  Resolved,
  Prepared,
  Pipelines,
  Records extends keyof Config = never,
  Merged extends keyof Config = never,
> extends BaseView<Config, Events, Resolved, Prepared, Records, Merged> {
  #style: ResolvedViewStyle;
  /** The shared style a checked config resolves to, until that config applies. */
  #checked?: { readonly config: Config; readonly style: ResolvedViewStyle };
  readonly #name: string;
  readonly #known: ReadonlySet<string>;
  readonly #styleDefaults: Partial<ResolvedViewStyle>;
  readonly #framed: readonly (keyof Camera)[];
  readonly #modes: readonly Mode[];
  readonly #clicks: boolean;
  #target: Camera;
  #version = 0;
  #drawn?: Camera;
  #viewport?: Viewport;
  #reported?: Camera;
  #animation?: Animation<Camera>;
  #fitting?: { readonly items?: readonly Item[]; readonly options: SetOptions };
  readonly #frames = new WeakMap<FrameInfo, Drawn<Camera, Hit>>();
  #selection: readonly Item[] = Object.freeze([]);
  #prune = false;
  #pointer: Point | null = null;
  #pointerVersion = 0;
  #hover: Hit | null = null;
  #hoverState: HoverState = 'idle';
  #hoverMs = 0;
  /** A budget miss suspends automatic hover until the scene next moves, or its options change. */
  #suspended = false;
  #settleAt = 0;
  /** Changes whenever what lies under a still pointer may have changed. */
  #epoch = 0;
  /** The latest asynchronous result, reused until the pointer or epoch changes. */
  #found?: { readonly pointer: number; readonly epoch: number; readonly item: Hit | null };
  #wake?: ReturnType<typeof setTimeout>;
  #search?: AbortController;
  #shade: Shade;
  #shadeSerial = 0;
  /** The shade's parameters, which it ticks each presented frame. */
  readonly #parameters = new Float32Array(64);
  #shadeAnimating = false;
  readonly #formats = new Set<GPUTextureFormat>();
  /** Where the last click landed and which of its overlapping hits it chose. */
  #clicked?: { readonly point: Point; readonly turn: number };
  #clicking?: AbortController;

  /** Checks every option, the input, and the starting camera before a view allocates anything. */
  constructor(gpu: Gpu, config: Config, shape: ItemShape<Camera>) {
    super(gpu, config, shape);
    this.#name = shape.name;
    this.#framed = shape.framed;
    this.#modes = shape.modes ?? MODES;
    this.#clicks = shape.clicks ?? true;
    this.#styleDefaults = shape.style ?? {};
    this.#known = new Set([
      ...OPTIONS,
      ...Object.keys(viewStyle),
      ...(shape.records ?? []),
      ...(shape.merged ?? []),
      ...(shape.options ?? []),
    ]);
    this.check(this.config as Config);
    this.#style = this.#checked!.style;
    void this.resolved;
    this.#shade = config.shade ?? defaultShade;
    this.#target = this.#resolvePatch(
      (config as { readonly camera?: Readonly<Record<string, unknown>> }).camera ?? {},
      undefined,
    );
  }

  // ── What a view supplies ──
  /** The camera of a view with no camera options. */
  protected abstract defaultCamera(): Camera;
  /** A valid, normalized camera replacing `current`, or the first one; throws on an invalid one. */
  protected abstract resolveCamera(camera: Camera, current: Camera | undefined): Camera;
  /** A camera part way between two; undefined when they cannot ease, such as across projections. */
  protected abstract interpolate(from: Camera, to: Camera, t: number): Camera | undefined;
  /** The camera moved by canvas pixels. */
  protected abstract panned(camera: Camera, dx: number, dy: number, viewport: Viewport): Camera;
  /** The camera zoomed about a canvas point; views that do not zoom omit it. */
  protected zoomed?(camera: Camera, factor: number, anchor: Point, viewport: Viewport): Camera;
  /** An item's canvas point in the latest drawn frame. */
  protected abstract position(item: Item): Point | null;
  /** Stable identity, for selection and hover changes. */
  protected abstract identify(item: Item): string;
  /** Throw when an item cannot be selected here, such as one of another source. */
  protected accept?(item: Item): void;
  /** Whether a selected item is still drawn, after a new source or `pruneSelection()`. */
  protected abstract contains(item: Item): boolean;
  /** Hits within the radius, nearest first, topmost breaking ties; past `limit` may be dropped. */
  protected abstract hits(
    point: Point,
    radiusPx: number,
    options: { readonly limit: number; readonly signal?: AbortSignal },
  ): readonly Hit[] | Promise<readonly Hit[]>;
  /** Build the pipelines for a target format, MSAA, and shade; the base caches each variant. */
  protected abstract pipelines(
    format: GPUTextureFormat,
    msaa: 1 | 4,
    shade: Shade,
  ): Promise<Pipelines>;
  /** React to a compiled shade replacing the previous one. */
  protected shaded?(): void;
  /** The view's own gestures; return a detach. Shared input is attached already. */
  protected listen?(canvas: HTMLCanvasElement, input: CanvasInput, mode: Mode): (() => void) | void;
  /** The view's own keys, before the shared ones; return true when handled. */
  protected key?(event: KeyboardEvent, mode: Mode): boolean;
  /** End a gesture in progress on Escape; return true when one ended. */
  protected cancel?(): boolean;
  /**
   * Throw on input options the view cannot use. A view with options of its own checks them and
   * passes the rest here, which rejects any it does not know.
   */
  protected checkInput(input: ViewInput): void {
    for (const key of Object.keys(input))
      if (!INPUT.has(key)) throw failure('invalid-input', 'Unknown input option: ' + key);
    if (input.mode !== undefined && !this.#modes.includes(input.mode))
      throw failure('invalid-input', 'Unsupported input mode: ' + String(input.mode));
    if (input.wheel !== undefined && input.wheel !== 'zoom' && input.wheel !== 'modifier')
      throw failure('invalid-input', 'Invalid wheel');
    if (input.keyboard !== undefined && typeof input.keyboard !== 'boolean')
      throw failure('invalid-input', 'Invalid keyboard');
  }

  // ── The contract ──
  get camera(): Camera {
    return this.#target;
  }
  get selection(): readonly Item[] {
    return this.#selection;
  }
  select(items: readonly Item[]): void {
    this.live();
    for (const item of items) this.accept?.(item);
    this.#selection = this.#unique(items);
    this.invalidate();
  }
  async pick(point: Point, options: PickOptions = {}): Promise<readonly Hit[]> {
    this.live();
    const radius = options.radiusPx ?? this.#style.pickRadiusPx,
      limit = options.limit ?? 16;
    if (
      !isPoint(point) ||
      !Number.isFinite(radius) ||
      radius < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw failure('invalid-input', 'Invalid pick');
    options.signal?.throwIfAborted();
    const hits = await this.hits(point, radius, { limit, signal: options.signal });
    return hits.length > limit ? hits.slice(0, limit) : hits;
  }
  locate(item: Item): Point | null {
    return this.position(item);
  }
  fit(items?: readonly Item[], options: SetOptions = {}): void {
    this.live();
    const framed = items?.length ? items : undefined;
    this.#fitting = { items: framed, options };
    if (!framed) this.#move({ ...this.camera, fit: true }, {});
    else this.invalidate();
  }
  reveal(item: Item, options: SetOptions = {}): void {
    this.live();
    const point = this.position(item),
      viewport = this.#viewport,
      inset = this.#style.revealPaddingPx;
    if (!point || !viewport) return;
    if (
      point[0] >= inset &&
      point[1] >= inset &&
      point[0] <= viewport.width - inset &&
      point[1] <= viewport.height - inset
    )
      return;
    const moved = this.panned(
      this.camera,
      viewport.width / 2 - point[0],
      viewport.height / 2 - point[1],
      viewport,
    );
    this.#move(this.resolveCamera({ ...moved, fit: false }, this.camera), options);
  }

  // ── For views ──
  /** The shared style, resolved over the view's defaults. */
  protected get viewStyle(): ResolvedViewStyle {
    return this.#style;
  }
  /** The shared style a config resolves to, for a view resolving its own style over it. */
  protected sharedStyle(config: Config): ResolvedViewStyle {
    return this.#checked?.config === config
      ? this.#checked.style
      : resolveViewStyle(config, this.#styleDefaults);
  }
  /** The compiled shade frames draw with. */
  protected get shade(): Shade {
    return this.#shade;
  }
  /** Whether the shade asked for another frame when it last ticked. */
  protected get shadeAnimating(): boolean {
    return this.#shadeAnimating;
  }
  /** The pointer over the canvas, in CSS pixels. */
  protected get pointerPoint(): Point | null {
    return this.#pointer;
  }
  /** Whether the style or the user's system asks for reduced motion. */
  protected get reducedMotion(): boolean {
    const motion = this.#style.motion;
    return (
      motion === 'reduce' ||
      (motion === 'auto' &&
        globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
    );
  }
  /** The item under the pointer, as published. */
  protected get hovered(): Hit | null {
    return this.#hover;
  }
  /** This frame's pipelines: its format, the style's MSAA, and the compiled shade. */
  protected framePipelines(frame: FrameInfo): Promise<Pipelines> {
    this.#formats.add(frame.format);
    return this.#variant(frame.format, this.#style.msaa, this.#shade);
  }
  /**
   * Tick the shade for this frame and bind its uniforms; an animated shade keeps frames coming. An
   * exported frame ticks a copy, leaving the shade's parameters as presented frames left them.
   */
  protected shadeFrame(frame: Preparation): GPUBufferBinding {
    const parameters = frame.presented ? this.#parameters : this.#parameters.slice(),
      pointerPx = this.#pointer,
      animating =
        this.#shade.tick?.(parameters, {
          timeMs: frame.timeMs,
          pointerPx,
          viewport: frame.viewport,
        }) ?? false;
    if (frame.presented) this.#shadeAnimating = animating;
    return frame.shade({ parameters, pointerPx, timeMs: frame.timeMs });
  }
  /**
   * The camera this frame draws: framed while `fit` holds, eased while animating. Call once per
   * prepare with how this frame's geometry frames items. An exported frame frames its own size and
   * draws where the camera is going, leaving the view's camera as it was.
   */
  protected async frameCamera(frame: FrameInfo, framing: Framing<Item, Camera>): Promise<Camera> {
    let target = this.camera;
    const fitting = this.#fitting;
    if (fitting || target.fit) {
      const framed = await framing(fitting?.items, target, frame.viewport);
      if (framed) {
        const next = this.resolveCamera(
          { ...target, ...framed, fit: !fitting?.items } as Camera,
          target,
        );
        if (!frame.presented) return next;
        if (fitting && this.#fitting === fitting) {
          this.#fitting = undefined;
          this.#animation = this.#ease(fitting.options);
          this.#target = next;
          this.#version++;
        } else if (!fitting && this.#target === target) this.#target = next;
        target = next;
      }
    }
    if (!frame.presented) return target;
    let camera = target,
      finished = false;
    const animation = this.#animation;
    if (animation) {
      animation.start ??= frame.timeMs;
      const t = Math.max(0, Math.min(1, (frame.timeMs - animation.start) / animation.duration));
      const eased = this.interpolate(animation.from, target, t * t * (3 - 2 * t));
      if (eased) camera = eased;
      finished = !eased || t >= 1;
    }
    this.#frames.set(frame, {
      camera,
      version: this.#version,
      animation,
      finished,
      viewport: frame.viewport,
    });
    return camera;
  }
  /** Record the camera a frame actually draws when the view adjusts it, such as an orbit step. */
  protected drawCamera(frame: FrameInfo, camera: Camera): void {
    const drawn = this.#frames.get(frame);
    if (drawn) drawn.camera = camera;
  }
  /**
   * The item to draw as hovered this frame. A synchronous search lands in this frame; an
   * asynchronous one in the next. `moving` adds the view's own motion, such as a drag. Call once
   * per prepare, after frameCamera. An exported frame draws the published hover and searches none.
   */
  protected hoverFrame(frame: FrameInfo, search: HoverSearch<Hit>, moving = false): Hit | null {
    if (!frame.presented) return this.#hover;
    const drawn = this.#frames.get(frame),
      policy = this.#style.hover,
      now = performance.now();
    const record = (item: Hit | null, state: HoverState, ms = 0, final = true): Hit | null => {
      if (drawn) drawn.hover = { item, state, pointer: this.#pointerVersion, ms, final };
      return item;
    };
    const viewport = this.#viewport;
    if (
      moving ||
      this.#animation ||
      (drawn &&
        this.#drawn &&
        (!same(drawn.camera, this.#drawn) ||
          drawn.viewport.width !== viewport?.width ||
          drawn.viewport.height !== viewport?.height))
    ) {
      this.#settleAt = now + SETTLE_MS;
      this.#epoch++;
      // What lies under the pointer changed, so the next settled search gets another chance.
      this.#suspended = false;
    }
    if (policy === 'off') return record(null, 'off');
    const point = this.#pointer;
    if (!point) return record(null, 'idle');
    if (policy === 'auto') {
      if (this.#suspended) return record(null, 'budget');
      if (now < this.#settleAt) return record(null, 'moving');
    }
    const found = this.#found;
    if (found?.pointer === this.#pointerVersion && found.epoch === this.#epoch)
      return record(found.item, 'active');
    if (this.#search) return record(this.#hover, 'active', 0, false);
    const controller = new AbortController(),
      version = this.#pointerVersion,
      epoch = this.#epoch;
    let started: unknown;
    const result = withinBudget(
      (check) =>
        (started = search(point, this.#style.pickRadiusPx, { check, signal: controller.signal })),
      policy === 'auto' ? this.#style.hoverBudgetMs : undefined,
    );
    if (!result.complete) {
      // An asynchronous search that started over budget is abandoned, never published.
      if (started instanceof Promise) {
        controller.abort();
        started.catch(() => {});
      }
      return record(null, 'budget', result.elapsedMs);
    }
    if (!(result.value instanceof Promise)) return record(result.value, 'active', result.elapsedMs);
    this.#search = controller;
    result.value.then(
      (item) => {
        if (this.#search !== controller) return;
        this.#search = undefined;
        if (version !== this.#pointerVersion || this.closed) return;
        this.#found = { pointer: version, epoch, item };
        this.#publish(item);
        this.invalidate();
      },
      (error: unknown) => {
        if (this.#search === controller) this.#search = undefined;
        if (!controller.signal.aborted) this.fail(error);
      },
    );
    return record(this.#hover, 'active', 0, false);
  }
  /** Move the pointer; frames search for the hovered item. */
  protected pointer(point: Point | null): void {
    if (point && !isPoint(point)) throw failure('invalid-input', 'Invalid pointer');
    this.#pointerVersion++;
    this.#search?.abort();
    this.#search = undefined;
    const had = this.#hover !== null,
      leaving = !point && this.#pointer !== null,
      shaded = this.#shade !== defaultShade;
    this.#pointer = point;
    if (!point) {
      this.#clearWake();
      this.#publish(null);
    }
    const policy = this.#style.hover,
      searching = policy !== 'off' && !(policy === 'auto' && this.#suspended);
    if (point && searching && policy === 'auto' && performance.now() < this.#settleAt) {
      this.#wakeAt(this.#settleAt);
      if (!had && !shaded) return;
    }
    // A frame may have drawn a hover that was never published; leaving redraws without it.
    if (((point || leaving) && searching) || had || shaded) this.invalidate();
  }
  /**
   * What lies under a still pointer changed, as when data arrives or an index makes searching
   * cheaper: search again, even after a budget miss.
   */
  protected refreshHover(): void {
    // Only a lifted suspension or a stale asynchronous result needs another frame.
    const stale = this.#suspended || !!this.#found;
    this.#suspended = false;
    this.#epoch++;
    if (this.#pointer && stale) this.invalidate();
  }
  /** Drop selected items the next drawn frame no longer contains, reporting the change. A new source does this already. */
  protected pruneSelection(): void {
    this.#prune = true;
  }
  /** Select as the user did: report it when it changed. */
  protected choose(items: readonly Item[]): void {
    const next = this.#unique(items);
    if (
      next.length === this.#selection.length &&
      next.every((item, i) => this.identify(item) === this.identify(this.#selection[i]))
    )
      return;
    for (const item of next) this.accept?.(item);
    this.#selection = next;
    this.invalidate();
    this.emit('select', next);
  }
  /**
   * Select what a click at a point hits. A modifier toggles the hit in the selection; clicking again
   * in place cycles through the hits there; clicking nothing clears the selection. A touch picks
   * farther around itself.
   */
  protected async click(
    point: Point,
    modifiers: Modifiers,
    options: { readonly touch?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const { touch, signal } = options,
      radius = touch ? Math.max(TOUCH_PX, this.#style.pickRadiusPx) : this.#style.pickRadiusPx;
    const hits = await this.hits(point, radius, { limit: 16, signal });
    if (signal?.aborted || this.closed) return;
    const last = this.#clicked,
      turn =
        last && Math.hypot(point[0] - last.point[0], point[1] - last.point[1]) < 3
          ? last.turn + 1
          : 0;
    this.#clicked = { point, turn };
    const hit = hits.length ? hits[turn % hits.length] : undefined;
    if (!(modifiers.shift || modifiers.control || modifiers.meta)) this.choose(hit ? [hit] : []);
    else if (hit) {
      const key = this.identify(hit),
        rest = this.#selection.filter((item) => this.identify(item) !== key);
      this.choose(rest.length === this.#selection.length ? [...rest, hit] : rest);
    }
  }
  /** Report a context menu at a canvas point with the hits there. */
  protected async menu(
    point: Point,
    trigger: 'pointer' | 'keyboard',
    modifiers: Modifiers,
  ): Promise<void> {
    try {
      const items = await this.hits(point, this.#style.pickRadiusPx, { limit: 16 });
      if (!this.closed)
        this.emit('contextmenu', { point, items, trigger, modifiers } as Events['contextmenu']);
    } catch (error) {
      this.fail(error);
    }
  }
  /** Zoom about a canvas point, or the center. */
  protected zoom(factor: number, anchor?: Point): void {
    const viewport = this.#viewport;
    if (!viewport || !this.zoomed || !Number.isFinite(factor) || factor <= 0) return;
    const zoomed = this.zoomed(
      this.camera,
      factor,
      anchor ?? [viewport.width / 2, viewport.height / 2],
      viewport,
    );
    this.#move(this.resolveCamera({ ...zoomed, fit: false }, this.camera), {});
  }
  /** Move by canvas pixels. */
  protected pan(dx: number, dy: number): void {
    const viewport = this.#viewport;
    if (!viewport || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.#move(
      this.resolveCamera(
        { ...this.panned(this.camera, dx, dy, viewport), fit: false },
        this.camera,
      ),
      {},
    );
  }
  /** Move the camera by a partial camera, as `set({ camera })` does, or follow the data with null. */
  protected moveCamera(patch: Readonly<Record<string, unknown>> | null, options: SetOptions): void {
    this.cameraMove(patch)(options);
  }

  // ── Base steps ──
  protected cameraMove(
    patch: Readonly<Record<string, unknown>> | null,
  ): (options: SetOptions) => void {
    if (patch === null) return (options) => this.fit(undefined, options);
    const current = this.camera,
      next = this.#resolvePatch(patch, current);
    return (options) => {
      this.#move(next, options);
      if (next.fit && !current.fit) this.#fitting = { options };
    };
  }
  protected check(config: Config): void {
    for (const key of Object.keys(config))
      if (!this.#known.has(key))
        throw failure('invalid-input', `Unknown ${this.#name} option: ${key}`);
    if (!config.source?.schema || !config.source.tables)
      throw failure('invalid-input', 'A Data source is required');
    const style = resolveViewStyle(config, this.#styleDefaults);
    this.checkInput(inputOf(config));
    // Keyed by config: a patch rejected after this check never applies its style.
    this.#checked = { config, style };
  }
  protected changed(previous: Config, next: Config, options: SetOptions): void {
    void options;
    const style = this.#style;
    this.#style = this.sharedStyle(next);
    this.#checked = undefined;
    if (previous.source !== next.source) this.#prune = true;
    if (
      previous.source !== next.source ||
      style.hover !== this.#style.hover ||
      style.hoverBudgetMs !== this.#style.hoverBudgetMs
    ) {
      this.#suspended = false;
      this.#settleAt = 0;
      this.#epoch++;
    }
    if (previous.shade !== next.shade) this.#compile(next.shade ?? defaultShade);
  }
  protected presented(frame: FrameInfo): void {
    const drawn = this.#frames.get(frame);
    if (!drawn) return;
    this.#frames.delete(frame);
    this.#drawn = drawn.camera;
    this.#viewport = drawn.viewport;
    if (drawn.finished && this.#animation === drawn.animation) this.#animation = undefined;
    if (!this.#animation && this.#version === drawn.version) this.#target = drawn.camera;
    if (!same(drawn.camera, this.#reported)) {
      this.#reported = drawn.camera;
      this.emit('camera', drawn.camera);
    }
    if (drawn.hover) this.#settle(drawn.hover);
    if (this.#prune) {
      this.#prune = false;
      const kept = this.#selection.filter((item) => this.contains(item));
      if (kept.length !== this.#selection.length) {
        this.#selection = Object.freeze(kept);
        this.emit('select', this.#selection);
      }
    }
  }
  protected measure(): Partial<ViewStats> {
    return {
      hover: this.#style.hover === 'off' ? 'off' : this.#suspended ? 'budget' : this.#hoverState,
      hoverMs: this.#hoverMs,
    };
  }
  protected get animating(): boolean {
    return !!this.#animation || this.#shadeAnimating;
  }
  protected attach(canvas: HTMLCanvasElement): () => void {
    const options = inputOf(this.config as Config),
      mode = options.mode ?? this.#modes[0],
      navigate = mode !== 'inspect';
    const input = createCanvasInput({
        canvas,
        keyboard: options.keyboard,
        touchAction: navigate ? 'none' : 'pan-x pan-y',
      }),
      { signal } = input;
    // A press is a click until it moves; a right press opens the menu where it is released in
    // place. The browser asks for the menu on press (macOS, Linux) or after release (Windows).
    let press:
        | {
            readonly id: number;
            readonly button: number;
            readonly point: Point;
            readonly touch: boolean;
            asked?: Modifiers;
          }
        | undefined,
      dragged = false;
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        dragged = false;
        if (event.button !== 0 && event.button !== 2) return;
        press = {
          id: event.pointerId,
          button: event.button,
          point: input.point(event),
          touch: event.pointerType === 'touch',
        };
        if (event.button === 2) input.capture(event.pointerId);
      },
      { signal },
    );
    canvas.addEventListener(
      'pointermove',
      (event) => {
        const point = input.point(event);
        if (
          press?.id === event.pointerId &&
          Math.hypot(point[0] - press.point[0], point[1] - press.point[1]) > CLICK_PX
        )
          dragged = true;
        this.pointer(point);
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerup',
      (event) => {
        if (press?.id !== event.pointerId || event.button !== press.button) return;
        const { asked, button, touch } = press;
        press = undefined;
        if (button === 0) {
          if (!dragged && this.#clicks) {
            this.#clicking?.abort();
            this.#clicking = new AbortController();
            const stop = AbortSignal.any([signal, this.#clicking.signal]);
            void this.click(input.point(event), inputModifiers(event), {
              touch,
              signal: stop,
            }).catch((error: unknown) => {
              if (!stop.aborted) this.fail(error);
            });
          }
          return;
        }
        input.release(event.pointerId);
        if (!asked) return;
        if (!dragged) void this.menu(input.point(event), 'pointer', asked);
        dragged = false;
      },
      { signal },
    );
    canvas.addEventListener('pointercancel', () => (press = undefined), { signal });
    canvas.addEventListener(
      'dblclick',
      (event) =>
        void this.#open(input.point(event), navigate).catch((error: unknown) => this.fail(error)),
      { signal },
    );
    canvas.ownerDocument.defaultView
      ?.matchMedia?.('(prefers-reduced-motion: reduce)')
      .addEventListener('change', () => this.invalidate(), { signal });
    canvas.addEventListener('pointerleave', () => this.pointer(null), { signal });
    canvas.addEventListener(
      'contextmenu',
      (event) => {
        event.preventDefault();
        if (press?.button === 2) press.asked = inputModifiers(event);
        else if (dragged) dragged = false;
        else void this.menu(input.point(event), 'pointer', inputModifiers(event));
      },
      { signal },
    );
    if (navigate && this.zoomed)
      canvas.addEventListener(
        'wheel',
        (event) => {
          if (options.wheel === 'modifier' && !event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          const delta = wheelDelta(event, { height: canvas.clientHeight });
          this.zoom(Math.exp(-Math.max(-1000, Math.min(1000, delta)) * 0.002), input.point(event));
        },
        { signal, passive: false },
      );
    if (options.keyboard !== false)
      canvas.addEventListener(
        'keydown',
        (event) => {
          if (event.target !== canvas) return;
          if (this.key?.(event, mode) || this.#key(event, navigate, canvas)) event.preventDefault();
        },
        { signal },
      );
    const own = this.listen?.(canvas, input, mode);
    return () => {
      own?.();
      this.#clicking?.abort();
      input.destroy();
      this.pointer(null);
    };
  }

  #key(event: KeyboardEvent, navigate: boolean, canvas: HTMLCanvasElement): boolean {
    const key = event.key;
    if (key === 'Escape') {
      if (!this.cancel?.()) this.choose([]);
    } else if (key === 'Enter') {
      const item = this.#selection[0];
      if (item === undefined) return false;
      this.emit('open', item);
    } else if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) {
      const last = this.#selection.at(-1);
      const point = (last !== undefined && this.position(last)) || [
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      ];
      void this.menu(point as Point, 'keyboard', inputModifiers(event));
    } else if (!navigate) return false;
    else if (key === 'Home') this.fit(undefined, { animate: true });
    else if ((key === '+' || key === '=') && this.zoomed) this.zoom(1.2);
    else if (key === '-' && this.zoomed) this.zoom(1 / 1.2);
    else return false;
    return true;
  }
  /** Open the item under a double click; a double click on nothing fits the data while navigating. */
  async #open(point: Point, navigate: boolean): Promise<void> {
    const [hit] = await this.hits(point, this.#style.pickRadiusPx, { limit: 1 });
    if (this.closed) return;
    if (hit !== undefined) this.emit('open', hit);
    else if (navigate) this.fit(undefined, { animate: true });
  }
  /**
   * The camera a patch moves to from `current`, or the starting camera without one. A null option
   * takes its default; moving a framed key stops fitting. Throws on an unknown key or invalid camera.
   */
  #resolvePatch(patch: Readonly<Record<string, unknown>>, current: Camera | undefined): Camera {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw failure('invalid-input', 'Invalid camera');
    const defaults = this.defaultCamera() as unknown as Record<string, unknown>,
      values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(defaults, key))
        throw failure('invalid-input', 'Unknown camera option: ' + key);
      values[key] = value ?? defaults[key];
    }
    const moved = this.#framed.some((key) => Object.hasOwn(values, key)),
      fit = (values.fit as boolean | undefined) ?? (moved ? false : (current?.fit ?? true));
    return this.resolveCamera(
      { ...(current ?? defaults), ...values, fit } as unknown as Camera,
      current,
    );
  }
  #move(next: Camera, options: SetOptions): void {
    this.#animation = this.#ease(options);
    this.#target = next;
    this.#version++;
    this.invalidate();
  }
  #ease(options: SetOptions): Animation<Camera> | undefined {
    const from = this.#drawn,
      duration = this.#style.animationMs;
    return options.animate && from && duration > 0 && !this.reducedMotion
      ? { from, duration }
      : undefined;
  }
  #unique(items: readonly Item[]): readonly Item[] {
    return Object.freeze([...new Map(items.map((item) => [this.identify(item), item])).values()]);
  }
  #publish(item: Hit | null): void {
    const before = this.#hover;
    if (
      before === item ||
      (before !== null && item !== null && this.identify(before) === this.identify(item))
    )
      return;
    this.#hover = item;
    this.emit('hover', item);
  }
  #settle(hover: Hovered<Hit>): void {
    if (hover.state === 'budget') this.#suspended = true;
    this.#hoverState = hover.state;
    this.#hoverMs = hover.ms;
    if (hover.final && hover.pointer === this.#pointerVersion) this.#publish(hover.item);
    this.#clearWake();
    if (
      this.#pointer &&
      this.#style.hover === 'auto' &&
      !this.#suspended &&
      performance.now() < this.#settleAt
    )
      this.#wakeAt(this.#settleAt);
  }
  #wakeAt(at: number): void {
    if (this.#wake !== undefined) return;
    this.#wake = setTimeout(
      () => {
        this.#wake = undefined;
        if (this.#pointer) this.invalidate();
      },
      Math.max(1, at - performance.now()),
    );
  }
  #clearWake(): void {
    if (this.#wake !== undefined) clearTimeout(this.#wake);
    this.#wake = undefined;
  }
  /** One pipeline variant, shared by every view of this kind on the Gpu. */
  #variant(format: GPUTextureFormat, msaa: 1 | 4, shade: Shade): Promise<Pipelines> {
    let kinds = variants.get(this.gpu);
    if (!kinds) variants.set(this.gpu, (kinds = new WeakMap()));
    let cache = kinds.get(this.constructor);
    if (!cache) kinds.set(this.constructor, (cache = new Map<string, Promise<unknown>>()));
    const key = format + ':' + msaa + ':' + shade.wgsl,
      found = cache.get(key) as Promise<Pipelines> | undefined;
    if (found) {
      // The most recently used variant is the last evicted.
      cache.delete(key);
      cache.set(key, found);
      return found;
    }
    const built = this.pipelines(format, msaa, shade),
      held = cache;
    held.set(key, built);
    void built.catch(() => {
      if (held.get(key) === built) held.delete(key);
    });
    if (held.size > VARIANTS) held.delete(held.keys().next().value!);
    return built;
  }
  /** Compile a shade for every format in use, then swap it in; a later shade wins. */
  #compile(shade: Shade): void {
    const serial = ++this.#shadeSerial,
      msaa = this.#style.msaa,
      formats: GPUTextureFormat[] = this.#formats.size ? [...this.#formats] : ['rgba8unorm'];
    Promise.all(formats.map((format) => this.#variant(format, msaa, shade))).then(
      () => {
        if (serial !== this.#shadeSerial || this.closed) return;
        this.#shade = shade;
        this.#parameters.fill(0);
        this.#shadeAnimating = false;
        this.shaded?.();
        this.invalidate();
      },
      (error: unknown) => {
        if (serial === this.#shadeSerial) this.fail(error);
      },
    );
  }
}

/** A config's input options, which views keep expanded from a mode shorthand. */
function inputOf(config: ItemViewConfig): ViewInput {
  const input = config.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw failure('invalid-input', 'Invalid input');
  return input;
}
function isPoint(point: unknown): point is Point {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
}
/** Shallow equality of camera values; tuples compare by element. */
function same(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  const xs = Object.keys(x);
  if (xs.length !== Object.keys(y).length) return false;
  for (const key of xs) {
    const u = x[key],
      v = y[key];
    if (u === v) continue;
    if (!Array.isArray(u) || !Array.isArray(v) || u.length !== v.length) return false;
    for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  }
  return true;
}
