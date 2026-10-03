import { failure, isFailure } from '@latkit/model';
import type { Gpu } from '../gpu.js';
import { createPresentation, type Presentation } from './presentation.js';
import { createTextureTarget, type TextureTarget } from './target.js';
import type {
  Encoding,
  FrameInfo,
  CapturedFrame,
  Preparation,
  Renderer,
  RenderTarget,
} from '../frame/render.js';
import type { HoverState } from './input.js';

/** A canvas point in CSS pixels. */
export type Point = readonly [x: number, y: number];

/** Config every view understands. */
export interface ViewConfig {
  /** Present on this canvas. Omit to render only images and video. */
  readonly canvas?: HTMLCanvasElement | null;
  /** Model coordinate shown, such as a time. */
  readonly at?: number | null;
  /** Stop presenting; config and state are kept. */
  readonly paused?: boolean;
}
export interface ViewEvents {
  /** A frame was drawn: where the view presents, or exported when not `presented`. */
  readonly frame: FrameInfo;
  /** A failure no call could report, such as a frame that failed to render. */
  readonly error: unknown;
}
const IMAGE_FORMATS: readonly string[] = ['png', 'jpeg', 'webp'];
export interface ImageOptions {
  /** Output size in pixels. Defaults to the canvas's, else 1280 × 720. */
  readonly width?: number;
  readonly height?: number;
  /** Pixels per CSS pixel. Defaults to the canvas's, else 1. */
  readonly pixelRatio?: number;
  /** Model coordinate shown; defaults to the view's. */
  readonly at?: number;
  /** `png` by default. */
  readonly format?: 'png' | 'jpeg' | 'webp';
  /** From 0 to 1, for `jpeg` and `webp`. */
  readonly quality?: number;
  readonly signal?: AbortSignal;
}
/** What every view measures. */
export interface ViewStats {
  readonly frames: number;
  /** Preparation time of the latest drawn frame. */
  readonly prepareMs: number;
  readonly drawCalls: number;
  readonly pickingBytes: number;
  readonly hover: HoverState;
  /** Hover search time in the latest frame; zero when it did not search. */
  readonly hoverMs: number;
}
export interface SetOptions {
  /** Ease camera and position changes. */
  readonly animate?: boolean;
}
/**
 * A set() argument. Keyed records, such as `vertices`, merge per entry and each entry per option;
 * camera, input, and limits merge per option. `null` removes an entry or resets an option. Any other
 * value replaces.
 */
export type Patch<C, Records extends keyof C = never, Merged extends keyof C = never> = {
  readonly [K in keyof C]?:
    | (K extends Records
        ? { readonly [E in keyof NonNullable<C[K]>]?: OptionsPatch<NonNullable<C[K]>[E]> | null }
        : K extends Merged
          ? OptionsPatch<NonNullable<C[K]>>
          : C[K])
    | null;
};
/** Some of an object's options, each of which may be null to reset it. */
export type OptionsPatch<T> = T extends object ? { readonly [K in keyof T]?: T[K] | null } : T;
/** Options as a view reads them: `ConfigShape.fields` shorthands are already `{ field }` objects. */
export type Expanded<T, K extends PropertyKey> = {
  readonly [P in keyof T]: P extends K ? Exclude<T[P], string> : T[P];
};

/** What every latkit view shares. */
export interface View<
  Config extends ViewConfig = ViewConfig,
  Events extends ViewEvents = ViewEvents,
> {
  /** The config as given, with every patch applied. Where the camera is lives on `camera`. */
  readonly config: Omit<Config, 'camera'>;
  set(patch: Patch<Config>, options?: SetOptions): void;
  stats(): ViewStats;
  /**
   * Render at any size and coordinate. A view on a canvas or in a composition stays as it is; a
   * view with neither presents in its images, so pick and locate follow the latest one.
   */
  image(options?: ImageOptions): Promise<Blob>;
  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void;
  /** Releases its canvas, input, and GPU resources; never its Gpu or sources. */
  destroy(): void;
}

/** How set() merges a view's config keys; every other key replaces. */
export interface ConfigShape {
  /** Keyed records that merge per entry, such as `vertices`. */
  readonly records?: readonly string[];
  /** Objects that merge per option, such as `camera`. */
  readonly merged?: readonly string[];
  /** Keys whose string value names one option, such as `layout: 'layered'` for its algorithm. */
  readonly shorthands?: Readonly<Record<string, string>>;
  /** Options of record entries whose string value names a field: `color: 'load'` is `{ field: 'load' }`. */
  readonly fields?: readonly string[];
  /** Records nested in entries that take the same field shorthands, such as diagram `ports`. */
  readonly nested?: readonly string[];
}

type Listener = (value: never) => void;
type Queued = readonly [event: PropertyKey, value: unknown];
const PRESENTATION = new Set(['canvas', 'at', 'paused']);
type Plain = Record<string, unknown>;

function merge(base: unknown, patch: Plain): Plain {
  const next: Plain = { ...(base as Plain | undefined) };
  for (const [key, value] of Object.entries(patch))
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  return next;
}
/** The config with a patch applied, following the view's shape. */
export function applyPatch<C>(config: C, patch: object, shape: ConfigShape): C {
  const next: Plain = { ...(config as Plain) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else if (shape.records?.includes(key)) {
      const record: Plain = { ...(next[key] as Plain | undefined) };
      for (const [entry, options] of Object.entries(value as Plain))
        if (options === null) delete record[entry];
        else if (options !== undefined) record[entry] = merge(record[entry], options as Plain);
      next[key] = record;
    } else if (shape.merged?.includes(key) && typeof value === 'object' && !Array.isArray(value))
      next[key] = merge(next[key], value as Plain);
    else next[key] = value;
  }
  return next as C;
}

/**
 * The base every latkit view extends. It owns the config and what it resolves to, presentation on a
 * canvas, input, images, and events. A view resolves its config, prepares a frame, and encodes what
 * it prepared; the base carries the prepared value from one step to the next.
 */
export abstract class BaseView<
  Config extends ViewConfig,
  Events extends ViewEvents,
  Resolved = Config,
  Prepared = void,
  Records extends keyof Config = never,
  Merged extends keyof Config = never,
> {
  #config: Config;
  #resolved?: Resolved;
  /** A checked config and what it resolves to, until that config applies. */
  #checked?: { readonly config: Config; readonly resolved: Resolved };
  /** Aborts when the view is destroyed. */
  readonly #alive = new AbortController();
  /** Input a composition routes here from the panel this view draws in. */
  #routed?: { readonly surface: HTMLCanvasElement; detach?: () => void };
  #closed = false;
  #listeners = new Map<PropertyKey, Set<Listener>>();
  #events: Queued[] = [];
  #invalidated = new Set<() => void>();
  #captured = false;
  #frameConfig?: Config;
  #configuration?: { previous: Config; next: Config; options: SetOptions };
  #changes = new Map<string, () => void>();
  #frames = 0;
  #prepareMs = 0;
  readonly #renderer: Renderer;
  #canvas?: CanvasState;
  #held = 0;
  #queue: Promise<void> = Promise.resolve();
  /** Settles once the latest captured frame is released, and the renderer is free again. */
  #released: Promise<void> = Promise.resolve();
  #composed = 0;
  /** The Gpu stopped: stop drawing, and report anything but an intended close. */
  readonly #stopped = (): void => {
    const reason: unknown = this.gpu.signal.reason;
    this.#stopFrame(reason);
    if (!isFailure(reason, 'closed')) this.fail(reason);
  };

  constructor(
    protected readonly gpu: Gpu,
    config: Config,
    private readonly shape: ConfigShape = {},
  ) {
    gpu.signal.throwIfAborted();
    // The camera is where a view starts, not state: set({ camera }) moves it and the view reports it.
    const { camera, ...rest } = config as Plain;
    void camera;
    this.#config = normalized(rest as unknown as Config, shape);
    const view = this as BaseView<Config, Events, Resolved, Prepared, Records, Merged>;
    this.#renderer = {
      get pending() {
        return view.pending;
      },
      get animating() {
        return view.animating;
      },
      capture: () => this.#capture(),
      on: (_event, listener) => {
        this.#invalidated.add(listener);
        return () => this.#invalidated.delete(listener);
      },
      destroy: () => this.destroy(),
    };
    internals.set(this, {
      gpu,
      renderer: this.#renderer,
      closed: () => this.#closed,
      hold: () => this.hold(),
      route: (surface) => {
        const routed: { readonly surface: HTMLCanvasElement; detach?: () => void } = {
          surface,
          detach: this.#input(surface),
        };
        this.#routed = routed;
        return () => {
          routed.detach?.();
          if (this.#routed === routed) this.#routed = undefined;
        };
      },
      compose: () => {
        if (this.#config.canvas)
          throw failure('invalid-input', 'A composed view presents through its composition');
        this.#composed++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            this.#composed--;
          }
        };
      },
    });
  }
  /**
   * Follow the Gpu and present on the config's canvas; call once the subclass is ready to render.
   * A view whose construction throws first holds nothing.
   */
  protected start(): void {
    void this.resolved;
    this.gpu.signal.addEventListener('abort', this.#stopped, { once: true });
    if (this.#config.canvas) this.#attach(this.#config.canvas);
  }

  get config(): Omit<Config, 'camera'> {
    return this.#config;
  }
  set(patch: Patch<Config, Records, Merged>, options: SetOptions = {}): void {
    this.live();
    void this.resolved;
    const { camera, ...rest } = patch as Plain;
    const previous = this.#config;
    // Shorthands expand before merging, so `input: 'inspect'` keeps the other input options.
    const next = normalized(
      applyPatch(previous, normalized(rest as unknown as Config, this.shape), this.shape),
      this.shape,
    );
    if (next.canvas !== previous.canvas && next.canvas && this.#composed)
      throw failure('invalid-input', 'A composed view presents through its composition');
    // Presentation keys are the base's alone, so playback's set({ at }) stays constant time.
    const own = Object.keys(rest).some((key) => !PRESENTATION.has(key));
    if (own) {
      this.check(next);
      // Keyed by config: a patch rejected after this never applies what it resolved to.
      this.#checked = { config: next, resolved: this.resolve(next) };
    }
    // Every part of the patch is valid before any of it applies.
    const move = camera === undefined ? undefined : this.cameraMove(camera as Plain | null);
    this.#config = next;
    if (own) {
      if (this.#captured) {
        this.#configuration = {
          previous: this.#configuration?.previous ?? previous,
          next,
          options,
        };
        this.invalidate();
      } else this.#configure(previous, next, options);
    }
    move?.(options);
    if (previous.canvas !== next.canvas) {
      this.#detach();
      if (next.canvas) this.#attach(next.canvas);
    } else if ((previous as Plain).input !== (next as Plain).input) {
      if (this.#canvas) {
        this.#canvas.input?.();
        this.#canvas.input = this.#input(this.#canvas.canvas);
      }
      if (this.#routed) {
        this.#routed.detach?.();
        this.#routed.detach = this.#input(this.#routed.surface);
      }
    }
    if (previous.paused !== next.paused) {
      if (next.paused) this.#stopFrame(new DOMException('View paused', 'AbortError'));
      else this.invalidate();
    }
    if (previous.at !== next.at) this.invalidate();
  }
  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void {
    this.live();
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as Listener);
    return () => set.delete(listener as Listener);
  }
  /** Every event dispatches on one microtask, in the order emitted; never inside a frame. */
  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    if (this.#events.push([event, value]) === 1)
      queueMicrotask(() => {
        const events = this.#events;
        this.#events = [];
        if (this.#closed) return;
        for (const [name, payload] of events)
          for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload as never);
      });
  }
  stats(): ViewStats {
    return {
      frames: this.#frames,
      prepareMs: this.#prepareMs,
      drawCalls: 0,
      pickingBytes: 0,
      hover: 'off',
      hoverMs: 0,
      ...this.measure(),
    };
  }
  /** Whether destroy has run; `live()` throws instead. */
  protected get closed(): boolean {
    return this.#closed;
  }
  /** Report a failure no caller awaits; unobserved failures reach the console. */
  protected fail(error: unknown): void {
    if (this.#listeners.get('error')?.size) this.emit('error', error as Events['error']);
    else console.error(error);
  }
  /** Schedule the latest desired state. A valid captured frame is allowed to finish. */
  protected invalidate(): void {
    if (this.#closed) return;
    for (const listener of this.#invalidated) listener();
    const state = this.#canvas;
    if (!state) return;
    state.wanted = true;
    this.#schedule();
  }
  /** Configuration seen by the captured frame; config itself always exposes the latest request. */
  protected get frameConfig(): Config {
    return this.#frameConfig ?? this.#config;
  }
  /** What the current config means to this view, resolved once per config. */
  protected get resolved(): Resolved {
    return (this.#resolved ??= this.resolve(this.#config));
  }
  /** Aborts when the view is destroyed, for the view's own background work. */
  protected get signal(): AbortSignal {
    return this.#alive.signal;
  }
  /** Follow every invalidation, as a composition of this view does; returns the unsubscribe. */
  protected onInvalidate(listener: () => void): () => void {
    this.#invalidated.add(listener);
    return () => this.#invalidated.delete(listener);
  }
  /** Coalesce changes to renderer state until the captured snapshot has settled. */
  protected defer(key: string, change: () => void): boolean {
    if (!this.#captured) return false;
    this.#changes.set(key, change);
    this.invalidate();
    return true;
  }
  #configure(previous: Config, next: Config, options: SetOptions): void {
    const before = this.resolved,
      checked = this.#checked;
    this.#checked = undefined;
    const after = checked?.config === next ? checked.resolved : this.resolve(next);
    this.#resolved = after;
    this.changed(previous, next, options);
    this.configure(after, before, options);
  }
  #capture(): CapturedFrame {
    this.live();
    if (this.#captured) throw failure('busy', 'View already has a captured frame');
    this.#captured = true;
    this.#frameConfig = this.#config;
    let free!: () => void;
    this.#released = new Promise<void>((resolve) => (free = resolve));
    let children: readonly CapturedFrame[];
    try {
      children = this.captureChildren();
    } catch (error) {
      this.#captured = false;
      this.#frameConfig = undefined;
      free();
      throw error;
    }
    let released = false;
    return {
      prepare: async (frame) => {
        const started = performance.now(),
          prepared = await this.prepare(frame),
          prepareMs = performance.now() - started;
        let settled = false;
        return {
          encode: (encoding) => this.encode(encoding, prepared),
          submitted: () => {
            if (settled) return;
            settled = true;
            this.#frames++;
            this.#prepareMs = prepareMs;
            this.emit('frame', frameInfo(frame) as Events['frame']);
            this.submitted(frame, prepared);
            // Exported frames draw the view's state; only presented ones advance it.
            if (frame.presented) this.presented(frame);
          },
          discard: () => {
            if (settled) return;
            settled = true;
            this.discard(prepared);
          },
        };
      },
      release: () => {
        if (released) return;
        released = true;
        try {
          const failures: unknown[] = [];
          for (const child of children) {
            try {
              child.release();
            } catch (error) {
              failures.push(error);
            }
          }
          this.#captured = false;
          this.#frameConfig = undefined;
          const configuration = this.#configuration;
          const changes = [...this.#changes.values()];
          this.#configuration = undefined;
          this.#changes.clear();
          if (!this.#closed) {
            try {
              if (configuration)
                this.#configure(configuration.previous, configuration.next, configuration.options);
            } catch (error) {
              failures.push(error);
            }
            for (const change of changes) {
              try {
                change();
              } catch (error) {
                failures.push(error);
              }
            }
          }
          if (failures.length) throw new AggregateError(failures, 'Snapshot release failed');
        } finally {
          free();
        }
      },
    };
  }
  protected live(): void {
    if (this.#closed) throw failure('closed', 'View is destroyed');
  }

  async image(options: ImageOptions = {}): Promise<Blob> {
    this.live();
    options.signal?.throwIfAborted();
    const format = options.format ?? 'png',
      quality = options.quality;
    if (!IMAGE_FORMATS.includes(format)) throw failure('invalid-input', 'Unsupported image format');
    if (quality !== undefined && !(quality >= 0 && quality <= 1))
      throw failure('invalid-input', 'Image quality must be between 0 and 1');
    const canvas = this.#config.canvas;
    const ratio =
      options.pixelRatio ?? (canvas ? canvas.ownerDocument.defaultView?.devicePixelRatio || 1 : 1);
    const width = options.width ?? (canvas ? Math.round(canvas.clientWidth * ratio) : 1280),
      height = options.height ?? (canvas ? Math.round(canvas.clientHeight * ratio) : 720);
    const release = await this.hold();
    let target: TextureTarget | undefined, buffer: GPUBuffer | undefined;
    try {
      target = createTextureTarget(this.gpu, { width, height, label: 'view image' });
      await this.gpu.render({
        completion: 'complete',
        timeMs: performance.now(),
        signal: options.signal,
        views: [
          {
            renderer: this.#renderer,
            target,
            at: options.at ?? this.#config.at ?? undefined,
            viewport: { width: width / ratio, height: height / ratio, pixelRatio: ratio },
            // A view that shows nowhere else presents in its images.
            presented: !canvas && !this.#composed,
          },
        ],
      });
      const rowBytes = Math.ceil((width * 4) / 256) * 256,
        device = this.gpu.device;
      buffer = device.createBuffer({
        label: 'view image readback',
        size: rowBytes * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: target.texture() },
        { buffer, bytesPerRow: rowBytes },
        [width, height],
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const rows = new Uint8Array(buffer.getMappedRange()),
        pixels = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        pixels.set(rows.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4);
      buffer.unmap();
      const image = new OffscreenCanvas(width, height);
      image.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
      return await image.convertToBlob({ type: 'image/' + format, quality });
    } finally {
      buffer?.destroy();
      target?.destroy();
      release();
    }
  }
  /** Take the renderer from the canvas until release, for images and video. */
  protected hold(): Promise<() => void> {
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const turn = this.#queue.then(async () => {
      this.#held++;
      const active = this.#canvas?.frame;
      this.#canvas?.active?.abort(new DOMException('Canvas frame held', 'AbortError'));
      await active;
      // An aborted frame may still be preparing; the renderer is free once its capture is released.
      await this.#released;
    });
    this.#queue = turn.then(() => finished);
    return turn.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.#held--;
        done();
        this.invalidate();
      };
    });
  }

  destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#alive.abort(new DOMException('View destroyed', 'AbortError'));
    this.gpu.signal.removeEventListener('abort', this.#stopped);
    try {
      this.#detach();
      this.#routed?.detach?.();
      this.#routed = undefined;
    } finally {
      this.#invalidated.clear();
      this.release();
      this.#listeners.clear();
      internals.delete(this);
    }
  }

  /** Validate a config before it resolves; throw to reject a patch. */
  protected check(config: Config): void {
    void config;
  }
  /** What a config means to this view: pure, resolved once per config; throw to reject it. */
  protected resolve(config: Config): Resolved {
    return config as unknown as Resolved;
  }
  /** React to a resolved config replacing the previous one; `resolved` is already the next. */
  protected abstract configure(next: Resolved, previous: Resolved, options: SetOptions): void;
  /** View-specific measures merged into stats(). */
  protected measure(): Partial<ViewStats> {
    return {};
  }
  /** Base-class step before configure; views implement configure instead. */
  protected changed(previous: Config, next: Config, options: SetOptions): void {
    void previous;
    void next;
    void options;
  }
  /** Base-class step after a presented frame is submitted; views implement submitted instead. */
  protected presented(frame: FrameInfo): void {
    void frame;
  }
  /**
   * Validate a camera patch, a partial camera or null to follow the data, and return the move that
   * applies it; throw on an invalid one. Views without a camera ignore it.
   */
  protected cameraMove(
    camera: Readonly<Record<string, unknown>> | null,
  ): ((options: SetOptions) => void) | undefined {
    void camera;
    return undefined;
  }
  /** Attach input to the canvas; return the detach. */
  protected attach(canvas: HTMLCanvasElement): (() => void) | undefined {
    void canvas;
    return undefined;
  }
  /** Release GPU and source subscriptions; the canvas is already detached. */
  protected abstract release(): void;
  /** Prepare a frame: read, upload, and build what `encode` draws. Never change shown state here. */
  protected abstract prepare(frame: Preparation): Promise<Prepared>;
  /** Record a prepared frame's commands; synchronous. */
  protected abstract encode(frame: Encoding, prepared: Prepared): void;
  protected captureChildren(): readonly CapturedFrame[] {
    return [];
  }
  /** A prepared frame was dropped before submission. */
  protected discard(prepared: Prepared): void {
    void prepared;
  }
  /** A prepared frame was submitted: commit what it shows. */
  protected submitted(frame: FrameInfo, prepared: Prepared): void {
    void frame;
    void prepared;
  }
  protected get pending(): Promise<void> | undefined {
    return undefined;
  }
  protected get animating(): boolean {
    return false;
  }

  #input(canvas: HTMLCanvasElement): (() => void) | undefined {
    const input = (this.#config as Plain).input as { mode?: string } | undefined;
    return input?.mode === 'none' ? undefined : this.attach(canvas);
  }
  #attach(canvas: HTMLCanvasElement): void {
    const window = canvas.ownerDocument.defaultView;
    if (!window) throw failure('unavailable', 'Canvas has no window');
    const presentation = createPresentation(this.gpu, { canvas });
    const state: CanvasState = { canvas, presentation, window, wanted: true, raf: 0 };
    this.#canvas = state;
    const resize = () => this.invalidate();
    const ratio = () => {
      state.ratio?.removeEventListener('change', onRatio);
      state.ratio = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
      state.ratio.addEventListener('change', onRatio, { once: true });
    };
    const onRatio = () => {
      ratio();
      resize();
    };
    state.cleanup = () => {
      state.observer?.disconnect();
      window.removeEventListener('resize', resize);
      state.ratio?.removeEventListener('change', onRatio);
    };
    try {
      if (typeof ResizeObserver !== 'undefined') {
        state.observer = new ResizeObserver(resize);
        try {
          state.observer.observe(canvas, { box: 'device-pixel-content-box' });
        } catch {
          state.observer.observe(canvas);
        }
      }
      window.addEventListener('resize', resize);
      ratio();
      state.input = this.#input(canvas);
      this.#schedule();
    } catch (error) {
      this.#detach();
      throw error;
    }
  }
  #detach(): void {
    const state = this.#canvas;
    if (!state) return;
    this.#canvas = undefined;
    state.active?.abort(new DOMException('Canvas detached', 'AbortError'));
    if (state.raf) state.window.cancelAnimationFrame(state.raf);
    try {
      state.input?.();
      state.cleanup?.();
    } finally {
      state.presentation.destroy();
    }
  }
  #stopFrame(reason: unknown): void {
    const state = this.#canvas;
    if (!state) return;
    state.active?.abort(reason);
    if (state.raf) state.window.cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.pendingTime = undefined;
  }
  #schedule(): void {
    const state = this.#canvas;
    if (
      state &&
      state.wanted &&
      !state.raf &&
      !this.#held &&
      !this.#config.paused &&
      !this.#closed &&
      !this.gpu.signal.aborted
    )
      state.raf = state.window.requestAnimationFrame((now) => this.#frame(state, now));
  }
  #frame(state: CanvasState, now: number): void {
    state.raf = 0;
    if (this.#canvas !== state || this.#held || this.#config.paused || !state.wanted) return;
    if (state.active) {
      state.pendingTime = now;
      if (this.animating) this.#schedule();
      return;
    }
    this.#draw(state, now);
  }
  #draw(state: CanvasState, now: number): void {
    if (state.raf) {
      state.window.cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    const { canvas, window, presentation } = state;
    const width = canvas.clientWidth,
      height = canvas.clientHeight;
    if (!width || !height) return;
    state.wanted = false;
    const limit = this.gpu.device.limits.maxTextureDimension2D;
    const scale = Math.min(window.devicePixelRatio || 1, limit / width, limit / height);
    const size = {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
    };
    const target: RenderTarget = {
      device: this.gpu.device,
      format: presentation.format,
      ...size,
      texture() {
        presentation.resize(size);
        return presentation.texture();
      },
    };
    const own = new AbortController();
    state.active = own;
    state.frame = this.gpu
      .render({
        timeMs: now,
        signal: own.signal,
        views: [
          {
            renderer: this.#renderer,
            target,
            at: this.#config.at ?? undefined,
            viewport: { width, height, pixelRatio: scale },
          },
        ],
      })
      .then(
        () => {
          if (!own.signal.aborted && this.animating) state.wanted = true;
        },
        (error: unknown) => {
          if (own.signal.aborted || this.#closed) return;
          if (isFailure(error, 'busy')) state.wanted = true;
          else this.fail(error);
        },
      )
      .finally(() => {
        if (state.active === own) state.active = undefined;
        const pendingTime = state.pendingTime;
        state.pendingTime = undefined;
        if (
          pendingTime !== undefined &&
          state.wanted &&
          this.#canvas === state &&
          !this.#held &&
          !this.#config.paused
        )
          this.#draw(state, pendingTime);
        else this.#schedule();
      });
    if (this.animating) {
      state.wanted = true;
      this.#schedule();
    }
  }
}
interface CanvasState {
  readonly canvas: HTMLCanvasElement;
  readonly presentation: Presentation;
  readonly window: Window;
  wanted: boolean;
  raf: number;
  active?: AbortController;
  pendingTime?: number;
  frame?: Promise<void>;
  observer?: ResizeObserver;
  ratio?: MediaQueryList;
  input?: () => void;
  cleanup?: () => void;
}
/** What a frame was, without what preparing it borrowed. */
function frameInfo(frame: FrameInfo): FrameInfo {
  const { width, height, at, timeMs, viewport, format, presented } = frame;
  return { width, height, at, timeMs, viewport, format, presented };
}
/** Expand string shorthands; `input: 'edit'` always means `{ mode: 'edit' }`. */
function normalized<C extends ViewConfig>(config: C, shape: ConfigShape): C {
  let result = config as Plain;
  for (const [key, option] of Object.entries({ input: 'mode', ...shape.shorthands }))
    if (typeof result[key] === 'string') result = { ...result, [key]: { [option]: result[key] } };
  if (shape.fields?.length)
    for (const key of shape.records ?? []) {
      const record = result[key];
      if (!record || typeof record !== 'object') continue;
      const next = expandRecord(record as Plain, shape);
      if (next !== record) result = { ...result, [key]: next };
    }
  return result as C;
}
const expansions = new WeakMap<object, object>();
/** Expand an entry once, keeping its identity when nothing changes so caches keyed on it survive. */
function expand(entry: Plain, shape: ConfigShape): Plain {
  let found = expansions.get(entry) as Plain | undefined;
  if (found) return found;
  let next: Plain | undefined;
  for (const key of shape.fields ?? [])
    if (typeof entry[key] === 'string') (next ??= { ...entry })[key] = { field: entry[key] };
  for (const key of shape.nested ?? []) {
    const nested = entry[key];
    if (!nested || typeof nested !== 'object') continue;
    const record = expandRecord(nested as Plain, shape);
    if (record !== nested) (next ??= { ...entry })[key] = record;
  }
  found = next ? Object.freeze(next) : entry;
  expansions.set(entry, found);
  return found;
}
function expandRecord(record: Plain, shape: ConfigShape): Plain {
  let next: Plain | undefined;
  for (const [name, entry] of Object.entries(record)) {
    if (!entry || typeof entry !== 'object') continue;
    const expanded = expand(entry as Plain, shape);
    if (expanded !== entry) (next ??= { ...record })[name] = expanded;
  }
  return next ?? record;
}
interface Internals {
  readonly gpu: Gpu;
  readonly renderer: Renderer;
  closed(): boolean;
  hold(): Promise<() => void>;
  /** Attach the view's input to a surface a composition routes events to; returns the detach. */
  route(surface: HTMLCanvasElement): () => void;
  compose(): () => void;
}
const internals = new WeakMap<object, Internals>();
function of(view: object): Internals {
  const found = internals.get(view);
  if (!found) throw failure('invalid-input', 'Expected a latkit view');
  if (found.closed()) throw failure('closed', 'View is destroyed');
  return found;
}
/** The renderer behind a view, for compositions and video. */
export function rendererOf(view: object): Renderer {
  return of(view).renderer;
}
/** The Gpu a view renders with. */
export function gpuOf(view: object): Gpu {
  return of(view).gpu;
}
/** Take a view's renderer from its canvas until release, for rendering it elsewhere. */
export function hold(view: object): Promise<() => void> {
  return of(view).hold();
}
/** Route a composed view's input from the surface of its panel until the returned detach. */
export function route(view: object, surface: HTMLCanvasElement): () => void {
  return of(view).route(surface);
}
/** Mark a view as presented by a composition until release. */
export function compose(view: object): () => void {
  return of(view).compose();
}
