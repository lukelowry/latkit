import type { Data } from '@latkit/model';
import type { Gpu } from '../gpu.js';
import { GpuError } from '../error.js';
import type { FrameInfo, Viewport } from '../frame/render.js';
import type { Shade } from '../style/shade.js';
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
import { resolveViewStyle, type ResolvedViewStyle, type ViewStyle } from './style.js';
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
  /** `navigate` moves the camera; `inspect` only hovers, selects, and opens menus. */
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

/** A hover search. Synchronous searches call `check`; asynchronous ones observe `signal`. */
export type HoverSearch<Hit> = (
  point: Point,
  radiusPx: number,
  options: { readonly check: () => void; readonly signal: AbortSignal },
) => Hit | null | Promise<Hit | null>;

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
type Mode = NonNullable<ViewInput['mode']>;
/** Hover waits this long after the camera, positions, or data move. */
const SETTLE_MS = 150;

/**
 * The base of every item view: the camera, selection, picking, hover, events, shade swaps, and the
 * shared input live here once. A view supplies its geometry through the abstract members.
 */
export abstract class BaseItemView<
  Config extends ItemViewConfig,
  Events extends ItemEvents<Item, Hit, Camera>,
  Item,
  Hit extends Item,
  Camera extends ViewCamera,
  Records extends keyof Config = never,
  Merged extends keyof Config = never,
> extends BaseView<Config, Events, Records, Merged> {
  #style: ResolvedViewStyle;
  #nextStyle?: ResolvedViewStyle;
  readonly #styleDefaults: Partial<ResolvedViewStyle>;
  readonly #initial?: Partial<Camera>;
  #target?: Camera;
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
  #shade: Shade | null;
  #shadeSerial = 0;
  readonly #formats = new Set<GPUTextureFormat>();

  constructor(
    gpu: Gpu,
    config: Config,
    shape: ConfigShape = {},
    styleDefaults: Partial<ResolvedViewStyle> = {},
  ) {
    super(gpu, config, shape);
    this.#initial = (config as { readonly camera?: Partial<Camera> }).camera;
    this.#styleDefaults = styleDefaults;
    this.#style = resolveViewStyle(this.config, styleDefaults);
    this.#shade = this.config.shade ?? null;
  }

  // ── What a view supplies ──
  /** Camera keys that framing sets; moving one by hand stops fitting. */
  protected abstract readonly framed: readonly (keyof Camera)[];
  /** The camera of a view with no camera options. */
  protected abstract defaultCamera(): Camera;
  /** A valid, normalized camera replacing `current`, or the first one; throws on an invalid one. */
  protected abstract resolveCamera(camera: Camera, current: Camera | undefined): Camera;
  /** The framed keys that show these items, or all the data; undefined until the data is ready. */
  protected abstract framing(
    items: readonly Item[] | undefined,
    camera: Camera,
    viewport: Viewport,
  ): Partial<Camera> | undefined | Promise<Partial<Camera> | undefined>;
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
  /** Build the pipelines a shade needs; the base orders compiles and swaps the shade on success. */
  protected abstract compileShade(shade: Shade | null, format: GPUTextureFormat): Promise<unknown>;
  /** React to a compiled shade replacing the previous one. */
  protected shaded?(): void;
  /** The view's own gestures; return a detach. Shared input is attached already. */
  protected listen?(canvas: HTMLCanvasElement, input: CanvasInput, mode: Mode): (() => void) | void;
  /** The view's own keys, before the shared ones; return true when handled. */
  protected key?(event: KeyboardEvent, mode: Mode): boolean;
  /** End a gesture in progress on Escape; return true when one ended. */
  protected cancel?(): boolean;
  /** Input mode when the config names none. */
  protected readonly inputMode: Mode = 'navigate';

  // ── The contract ──
  get camera(): Camera {
    return (this.#target ??= this.#initialCamera());
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
      throw new GpuError('invalid-input', 'Invalid pick');
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
  /** The compiled shade frames draw with. */
  protected get shade(): Shade | null {
    return this.#shade;
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
  /** The camera this frame draws: framed while `fit` holds, eased while animating. Call once per prepare. */
  protected async frameCamera(frame: FrameInfo): Promise<Camera> {
    this.#formats.add(frame.format);
    let target = this.camera;
    const fitting = this.#fitting;
    if (fitting || target.fit) {
      const framed = await this.framing(fitting?.items, target, frame.viewport);
      if (framed) {
        const next = this.resolveCamera(
          { ...target, ...framed, fit: !fitting?.items } as Camera,
          target,
        );
        if (fitting && this.#fitting === fitting) {
          this.#fitting = undefined;
          this.#animation = this.#ease(fitting.options);
          this.#target = next;
          this.#version++;
        } else if (!fitting && this.#target === target) this.#target = next;
        target = next;
      }
    }
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
   * per prepare, after frameCamera.
   */
  protected hoverFrame(frame: FrameInfo, search: HoverSearch<Hit>, moving = false): Hit | null {
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
    if (point && !isPoint(point)) throw new GpuError('invalid-input', 'Invalid pointer');
    this.#pointerVersion++;
    this.#search?.abort();
    this.#search = undefined;
    const had = this.#hover !== null,
      leaving = !point && this.#pointer !== null;
    this.#pointer = point;
    if (!point) {
      this.#clearWake();
      this.#publish(null);
    }
    const policy = this.#style.hover,
      searching = policy !== 'off' && !(policy === 'auto' && this.#suspended);
    if (point && searching && policy === 'auto' && performance.now() < this.#settleAt) {
      this.#wakeAt(this.#settleAt);
      if (!had && !this.#shade) return;
    }
    // A frame may have drawn a hover that was never published; leaving redraws without it.
    if (((point || leaving) && searching) || had || this.#shade) this.invalidate();
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

  // ── Base steps ──
  protected moveCamera(patch: Readonly<Record<string, unknown>> | null, options: SetOptions): void {
    if (patch === null) return this.fit(undefined, options);
    const defaults = this.defaultCamera() as unknown as Record<string, unknown>;
    const values = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, value ?? defaults[key]]),
    );
    const current = this.camera,
      moved = this.framed.some((key) => key in values),
      fit = (values.fit as boolean | undefined) ?? (moved ? false : current.fit);
    this.#move(this.resolveCamera({ ...current, ...values, fit } as Camera, current), options);
    if (values.fit === true && !current.fit) this.#fitting = { options };
  }
  protected check(config: Config): void {
    this.#nextStyle = resolveViewStyle(config, this.#styleDefaults);
  }
  protected changed(previous: Config, next: Config, options: SetOptions): void {
    void options;
    const style = this.#style;
    this.#style = this.#nextStyle ?? resolveViewStyle(next, this.#styleDefaults);
    this.#nextStyle = undefined;
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
    if (previous.shade !== next.shade) this.#compile(next.shade ?? null);
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
    return !!this.#animation;
  }
  protected attach(canvas: HTMLCanvasElement): () => void {
    const config = this.config.input,
      options: ViewInput = typeof config === 'string' ? { mode: config } : (config ?? {}),
      mode = options.mode ?? this.inputMode,
      navigate = mode !== 'inspect';
    const input = createCanvasInput({
        canvas,
        keyboard: options.keyboard,
        touchAction: navigate ? 'none' : 'pan-x pan-y',
      }),
      { signal } = input;
    canvas.addEventListener('pointermove', (event) => this.pointer(input.point(event)), { signal });
    canvas.ownerDocument.defaultView
      ?.matchMedia?.('(prefers-reduced-motion: reduce)')
      .addEventListener('change', () => this.invalidate(), { signal });
    canvas.addEventListener('pointerleave', () => this.pointer(null), { signal });
    canvas.addEventListener(
      'contextmenu',
      (event) => {
        event.preventDefault();
        void this.menu(input.point(event), 'pointer', inputModifiers(event));
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
      input.destroy();
      this.pointer(null);
    };
  }

  #key(event: KeyboardEvent, navigate: boolean, canvas: HTMLCanvasElement): boolean {
    const key = event.key;
    if (key === 'Escape') {
      if (!this.cancel?.()) this.choose([]);
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
  #initialCamera(): Camera {
    const given: Partial<Camera> = this.#initial ?? {},
      moved = this.framed.some((key) => key in given);
    return this.resolveCamera(
      { ...this.defaultCamera(), ...given, fit: given.fit ?? !moved } as Camera,
      undefined,
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
  #compile(shade: Shade | null): void {
    const serial = ++this.#shadeSerial,
      formats: GPUTextureFormat[] = this.#formats.size ? [...this.#formats] : ['rgba8unorm'];
    Promise.all(formats.map((format) => this.compileShade(shade, format))).then(
      () => {
        if (serial !== this.#shadeSerial || this.closed) return;
        this.#shade = shade;
        this.shaded?.();
        this.invalidate();
      },
      (error: unknown) => {
        if (serial === this.#shadeSerial) this.fail(error);
      },
    );
  }
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
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const u = x[key],
      v = y[key];
    if (u === v) continue;
    if (!Array.isArray(u) || !Array.isArray(v) || u.length !== v.length) return false;
    for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  }
  return true;
}
