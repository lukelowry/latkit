import type { Gpu } from './gpu.js';
import { GpuError } from './error.js';
import { createPresentation, type Presentation } from './presentation.js';
import { createRenderTarget, type TextureTarget } from './target.js';
import type {
  Encoding,
  FrameInfo,
  CapturedFrame,
  Preparation,
  Renderer,
  RenderTarget,
} from './render.js';

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
  /** A frame was drawn, on the canvas or offscreen. */
  readonly frame: FrameInfo;
  /** A failure no call could report, such as a frame that failed to render. */
  readonly error: unknown;
}
export interface ImageOptions {
  /** Output size in pixels. Defaults to the canvas's, else 1280 × 720. */
  readonly width?: number;
  readonly height?: number;
  /** Pixels per CSS pixel. Defaults to the canvas's, else 1. */
  readonly pixelRatio?: number;
  /** Model coordinate shown; defaults to the view's. */
  readonly at?: number;
  /** Image media type, such as `image/png` (the default) or `image/jpeg`. */
  readonly type?: string;
  readonly quality?: number;
  readonly signal?: AbortSignal;
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

/** What every latkit view shares. */
export interface View<
  Config extends ViewConfig = ViewConfig,
  Events extends ViewEvents = ViewEvents,
> {
  /** The config as given, with every patch applied. */
  readonly config: Config;
  set(patch: Patch<Config>, options?: SetOptions): void;
  /** Render offscreen at any size and coordinate; the canvas keeps presenting afterwards. */
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
}

type Listener = (value: never) => void;
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
 * The base every latkit view extends. It owns the config, presentation on a canvas, input, images,
 * and events; a subclass renders and reacts to config changes.
 */
export abstract class BaseView<
  Config extends ViewConfig,
  Events extends ViewEvents,
  Records extends keyof Config = never,
  Merged extends keyof Config = never,
> {
  #config: Config;
  #closed = false;
  #listeners = new Map<PropertyKey, Set<Listener>>();
  #invalidated = new Set<() => void>();
  #captured = false;
  #frameConfig?: Config;
  #configuration?: { previous: Config; next: Config; options: SetOptions };
  #changes = new Map<string, () => void>();
  #cameraChange?: { reset: boolean; patch: Plain; options: SetOptions };
  readonly #renderer: Renderer;
  #canvas?: CanvasState;
  #held = 0;
  #queue: Promise<void> = Promise.resolve();
  #composed = 0;

  constructor(
    protected readonly gpu: Gpu,
    config: Config,
    private readonly shape: ConfigShape = {},
  ) {
    // The camera is where a view starts, not state: set({ camera }) moves it and the view reports it.
    const { camera, ...rest } = config as Plain;
    void camera;
    this.#config = normalized(rest as unknown as Config, shape);
    const view = this as BaseView<Config, Events, Records, Merged>;
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
      compose: () => {
        if (this.#config.canvas)
          throw new GpuError('invalid-input', 'A composed view presents through its composition');
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
    void gpu.lost.then((info) => {
      if (this.#closed) return;
      this.#stopFrame(info);
      this.fail(new GpuError('device-lost', 'GPU device lost: ' + info.message, { cause: info }));
    });
  }
  /** Present on the config's canvas; call once the subclass is ready to render. */
  protected start(): void {
    if (this.#config.canvas) this.#attach(this.#config.canvas);
  }

  get config(): Config {
    return this.#config;
  }
  set(patch: Patch<Config, Records, Merged>, options: SetOptions = {}): void {
    this.live();
    const { camera, ...rest } = patch as Plain;
    const next = normalized(applyPatch(this.#config, rest, this.shape), this.shape);
    const previous = this.#config;
    if (next.canvas !== previous.canvas && next.canvas && this.#composed)
      throw new GpuError('invalid-input', 'A composed view presents through its composition');
    // Presentation keys are the base's alone, so playback's set({ at }) stays constant time.
    const own = Object.keys(rest).some((key) => !PRESENTATION.has(key));
    if (own) this.check(next);
    this.#config = next;
    if (own) {
      if (this.#captured) {
        this.#configuration = {
          previous: this.#configuration?.previous ?? previous,
          next,
          options,
        };
        this.invalidate();
      } else this.configure(previous, next, options);
    }
    if (camera !== undefined) this.moveCamera(camera as Plain | null, options);
    if (previous.canvas !== next.canvas) {
      this.#detach();
      if (next.canvas) this.#attach(next.canvas);
    } else if (this.#canvas && (previous as Plain).input !== (next as Plain).input) {
      this.#canvas.input?.();
      this.#canvas.input = this.#input(this.#canvas.canvas);
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
  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(value as never);
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
  /** Coalesce changes to renderer state until the captured snapshot has settled. */
  protected defer(key: string, change: () => void): boolean {
    if (!this.#captured) return false;
    if (key === 'camera') this.#cameraChange = undefined;
    this.#changes.set(key, change);
    this.invalidate();
    return true;
  }
  protected deferCamera(
    camera: Readonly<Record<string, unknown>> | null,
    options: SetOptions,
  ): boolean {
    if (!this.#captured) return false;
    const previous = this.#cameraChange;
    this.#cameraChange = {
      reset: camera === null || !!previous?.reset,
      patch: camera === null ? {} : { ...previous?.patch, ...camera },
      options,
    };
    this.#changes.set('camera', () => {
      const change = this.#cameraChange;
      this.#cameraChange = undefined;
      if (!change) return;
      if (change.reset) this.moveCamera(null, change.options);
      if (Object.keys(change.patch).length) this.moveCamera(change.patch, change.options);
    });
    this.invalidate();
    return true;
  }
  #capture(): CapturedFrame {
    this.live();
    if (this.#captured) throw new GpuError('busy', 'View already has a captured frame');
    this.#captured = true;
    this.#frameConfig = this.#config;
    let children: readonly CapturedFrame[];
    try {
      children = this.captureChildren();
    } catch (error) {
      this.#captured = false;
      this.#frameConfig = undefined;
      throw error;
    }
    let released = false;
    return {
      prepare: async (frame) => {
        try {
          await this.prepare(frame);
        } catch (error) {
          this.discard();
          throw error;
        }
        let settled = false;
        return {
          encode: (encoding) => this.encode(encoding),
          submitted: () => {
            if (settled) return;
            settled = true;
            this.submitted(frame);
            this.emit('frame', frame as Events['frame']);
          },
          discard: () => {
            if (settled) return;
            settled = true;
            this.discard();
          },
        };
      },
      release: () => {
        if (released) return;
        released = true;
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
              this.configure(configuration.previous, configuration.next, configuration.options);
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
        this.#cameraChange = undefined;
        if (failures.length) throw new AggregateError(failures, 'Snapshot release failed');
      },
    };
  }
  protected live(): void {
    if (this.#closed) throw new GpuError('closed', 'View is destroyed');
  }

  async image(options: ImageOptions = {}): Promise<Blob> {
    this.live();
    options.signal?.throwIfAborted();
    const canvas = this.#config.canvas;
    const ratio =
      options.pixelRatio ?? (canvas ? canvas.ownerDocument.defaultView?.devicePixelRatio || 1 : 1);
    const width = options.width ?? (canvas ? Math.round(canvas.clientWidth * ratio) : 1280),
      height = options.height ?? (canvas ? Math.round(canvas.clientHeight * ratio) : 720);
    const release = await this.hold();
    let target: TextureTarget | undefined, buffer: GPUBuffer | undefined;
    try {
      target = createRenderTarget({ gpu: this.gpu, width, height, label: 'view image' });
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
      return await image.convertToBlob({
        type: options.type ?? 'image/png',
        quality: options.quality,
      });
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
    try {
      this.#detach();
    } finally {
      this.#invalidated.clear();
      this.release();
      this.#listeners.clear();
      internals.delete(this);
    }
  }

  /** Validate a config before it applies; throw to reject a patch. */
  protected check(config: Config): void {
    void config;
  }
  /** React to config changes; the config is already current. */
  protected abstract configure(previous: Config, next: Config, options: SetOptions): void;
  /** Move the camera by a partial camera, or reset it with null; views without one ignore it. */
  protected moveCamera(
    camera: Readonly<Record<string, unknown>> | null,
    options: SetOptions,
  ): void {
    void camera;
    void options;
  }
  /** Attach input to the canvas; return the detach. */
  protected attach(canvas: HTMLCanvasElement): (() => void) | undefined {
    void canvas;
    return undefined;
  }
  /** Release GPU and source subscriptions; the canvas is already detached. */
  protected abstract release(): void;
  protected abstract prepare(frame: Preparation): Promise<void>;
  protected abstract encode(frame: Encoding): void;
  protected captureChildren(): readonly CapturedFrame[] {
    return [];
  }
  protected discard(): void {}
  protected submitted(frame: FrameInfo): void {
    void frame;
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
    if (!window) throw new GpuError('unavailable', 'Canvas has no window');
    const presentation = createPresentation({ gpu: this.gpu, canvas });
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
    if (state && state.wanted && !state.raf && !this.#held && !this.#config.paused && !this.#closed)
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
          if (error instanceof GpuError && error.code === 'busy') state.wanted = true;
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
/** Expand string shorthands; `input: 'edit'` always means `{ mode: 'edit' }`. */
function normalized<C extends ViewConfig>(config: C, shape: ConfigShape): C {
  let result = config as Plain;
  for (const [key, option] of Object.entries({ input: 'mode', ...shape.shorthands }))
    if (typeof result[key] === 'string') result = { ...result, [key]: { [option]: result[key] } };
  return result as C;
}
interface Internals {
  readonly gpu: Gpu;
  readonly renderer: Renderer;
  closed(): boolean;
  hold(): Promise<() => void>;
  compose(): () => void;
}
const internals = new WeakMap<object, Internals>();
function of(view: object): Internals {
  const found = internals.get(view);
  if (!found) throw new GpuError('invalid-input', 'Expected a latkit view');
  if (found.closed()) throw new GpuError('closed', 'View is destroyed');
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
/** Mark a view as presented by a composition until release. */
export function compose(view: object): () => void {
  return of(view).compose();
}
