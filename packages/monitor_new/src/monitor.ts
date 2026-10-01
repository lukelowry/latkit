import type { Domain, RequestOptions, SampleRange, Queryable, Update } from '@latkit/model';
import type {
  Camera2D,
  ContextMenu,
  DataHit,
  Gpu,
  HoverState,
  Invalidation,
  Renderer,
  Shade,
} from '@latkit/gpu';
import type { MonitorData, Reading, Trace } from './data.js';
import type { Limits, Options } from './options.js';
export interface MonitorEvents {
  readonly invalidate: Invalidation;
  readonly hover: Reading | null;
  readonly select: Reading | null;
  readonly contextmenu: ContextMenu<Reading>;
  readonly window: SampleRange;
  readonly valueDomain: Domain | null;
  readonly fit: boolean;
}
export interface MonitorStats {
  readonly traces: number;
  readonly historyBytes: number;
  readonly pickingBytes: number;
  readonly prepareMs: number;
  readonly drawCalls: number;
  readonly frames: number;
  readonly refining: boolean;
  readonly hover: HoverState;
}
export interface HitTestOptions extends RequestOptions {
  readonly radiusPx?: number;
  /** Nearest observations, ordered by distance; default 16. */
  readonly limit?: number;
}
/** Playhead uses the observation coordinate supplied as RenderView.at. */
export interface Monitor extends Renderer {
  setData(data: MonitorData): void;
  setTrace(name:string,patch:Partial<Trace>):void;
  setOptions(options: Options): void;
  setShade(shade: Shade | null): Promise<void>;
  getCamera(): Camera2D | null;
  setCamera(camera: Camera2D): void;
  setWindow(window: SampleRange): void;
  /** Focus a native row; field narrows focus when supplied. Does not emit select. */
  select(item: DataHit | null): void;
  setPointer(point: readonly [number, number] | null): void;
  panBy(dx: number, dy: number): void;
  zoomBy(factor: number | readonly [number, number], anchor?: readonly [number, number]): void;
  fit(): void;
  /** Local CSS coordinates. Raw refinement is cancellable and scoped to the presented version. */
  hitTest(point: readonly [number, number], options?: HitTestOptions): Promise<readonly Reading[]>;
  toData(
    point: readonly [number, number],
  ): { readonly coordinate: number; readonly value: number } | null;
  stats(): MonitorStats;
  on<K extends keyof MonitorEvents>(
    event: K,
    listener: (value: MonitorEvents[K]) => void,
  ): () => void;
}
export interface MonitorOptions {
  readonly gpu: Gpu;
  readonly data: MonitorData;
  readonly camera?: Camera2D;
  readonly options?: Options;
  readonly limits?: Limits;
  readonly shade?: Shade;
}

import {
  GpuError,
  fitCamera,
  worldPoint,
  zoomCamera,
  type Preparation,
  type Encoding,
  type FrameInfo,
} from '@latkit/gpu';
import {
  defaults,
  settings,
  limits,
  expanded,
  finite,
  windowRange,
  fail,
  type Settings,
} from './config.js';
import { binding, describeBindings, validateData, extent, type Binding } from './bindings.js';
import { axes, plot, type Axes } from './axes.js';
import { mergeDomain } from './history.js';
import { Job } from './job.js';
import { pipelines, type Pipelines } from './rendering/pipelines.js';
import {
  image,
  imageBytes,
  destroyImage,
  enroll,
  prepareChunk,
  paint,
  prepareScreen,
  composite,
  type Image,
  type Draw,
  type Screen,
} from './rendering/painter.js';
import { deferred, wait, asError } from './async.js';
import { pick, HoverBudget } from './picking.js';
import type { Seams } from './segments.js';

export const interactions = new WeakMap<
  Monitor,
  { select(value: Reading | null): void; context(value: ContextMenu<Reading>): void }
>();
export function createMonitor(options: MonitorOptions): Monitor {
  return new MonitorView(options);
}
class MonitorView implements Monitor {
  private readonly gpu: Gpu;
  private data: MonitorData;
  private options: Settings;
  private readonly limits: Required<Limits>;
  private readonly stop = new AbortController();
  private closed = false;
  private listeners = new Map<string, Set<(value: never) => void>>();
  private subscriptions: (() => void)[] = [];
  private bindings?: Binding[];
  private setup?: Promise<void>;
  private setupStop?: AbortController;
  private error?: unknown;
  private window: SampleRange;
  private y: Domain;
  private autoY = true;
  private minimum?:number;
  private camera?: Camera2D;
  private viewport?: FrameInfo['viewport'];
  private layout?: Axes;
  private layoutKey = '';
  private format?: GPUTextureFormat;
  private pipeline?: Pipelines;
  private compiling?: Promise<Pipelines>;
  private shade: Shade | null;
  private parameters = new Float32Array(64);
  private animate = false;
  private timeMs = 0;
  private front?: Image;
  private back?: Image;
  private focusImage?: Image;
  private job?: Job;
  private focusJob?: Job;
  private tails?: Seams;
  private dirty = true;
  private focusDirty = false;
  private selected: DataHit | null = null;
  private pointer: readonly [number, number] | null = null;
  private debounce?: {
    promise: Promise<void>;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private append?: { source: Queryable; offset: number; count: number };
  private generation = 0;
  private updating?: Promise<void>;
  private presentedVersions = new Map<Queryable, string>();
  private prepared?: {
    pipeline: Pipelines;
    screen: Screen;
    paint: { job: Job; draws: Draw[] }[];
    clear: Image[];
    finish: Job[];
  };
  private pickStop?: AbortController;
  private hoverState: HoverState = 'idle';
  private hoverTask?: ReturnType<typeof setTimeout>;
  private frames = 0;
  private drawCalls = 0;
  private prepareMs = 0;
  private rowCount = 0;
  private pickingBytes = 0;
  constructor(input: MonitorOptions) {
    validateData(input.data);
    this.gpu = input.gpu;
    this.data = input.data;
    this.options = settings(defaults, input.options ?? {});
    this.limits = limits(input.limits);
    this.window = windowRange(input.data.window);
    this.y = this.options.valueDomain === 'auto' ? [0, 1] : expanded(this.options.valueDomain);
    this.shade = input.shade ?? null;
    this.camera = input.camera;
    interactions.set(this, {
      select: (value) => this.emit('select', value),
      context: (value) => this.emit('contextmenu', value),
    });
    this.watch();
  }
  private live() {
    if (this.closed) throw new GpuError('closed', 'Monitor is destroyed');
  }
  private emit<K extends keyof MonitorEvents>(event: K, value: MonitorEvents[K]) {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
  on<K extends keyof MonitorEvents>(
    event: K,
    listener: (value: MonitorEvents[K]) => void,
  ): () => void {
    this.live();
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (value: never) => void);
    return () => set!.delete(listener as (value: never) => void);
  }
  private refresh() {
    if (!this.closed) this.emit('invalidate', 'refresh');
  }
  private watch() {
    for (const dispose of this.subscriptions) dispose();
    this.subscriptions = [];
    const sources = new Set([this.data.source]);
    for (const trace of Object.values(this.data.traces))
      for (const value of [trace.field, trace.color?.field, trace.visible, trace.shade])
        if (value) {
          const ref = binding(value, this.data.source, trace.from);
          if (ref) sources.add(ref.source);
        }
    for (const source of sources)
      this.subscriptions.push(source.on('change', (change) => this.update(source, change)));
  }
  private update(source: Queryable, change: Update) {
    if (this.closed || ['commands', 'diagnostics', 'status'].includes(change.kind)) return;
    this.pickStop?.abort();
    this.generation++;
    if (change.kind === 'closed') {
      this.error = new GpuError('closed', 'A monitor source closed');
      this.cancel();
      this.refresh();
      return;
    }
    if (change.kind === 'append' && (this.job || this.focusJob)) {
      this.restart(false);
      return;
    }
    if (
      change.kind === 'append' &&
      this.bindings &&
      this.bindings.every((b) => b.source === source) &&
      !this.options.follow
    ) {
      const previous = this.append;
      if (previous && previous.source === source) {
        const end = Math.max(
          previous.offset + previous.count,
          change.frames.offset + change.frames.count,
        );
        this.append = {
          source,
          offset: Math.min(previous.offset, change.frames.offset),
          count: end - Math.min(previous.offset, change.frames.offset),
        };
      } else this.append = { source, ...change.frames };
      this.focusDirty = !!this.selected;
      this.refresh();
      return;
    }
    if(['replace','schema','structure'].includes(change.kind))this.select(null);
    this.bindings = undefined;
    this.setup = undefined;
    this.generation++;
    this.error = undefined;
    if (change.kind === 'evict') {
      destroyImage(this.front);
      this.front = undefined;
      destroyImage(this.back);
      this.back = undefined;
      this.tails = undefined;
    }
    this.restart(false);
    if (change.kind === 'evict' || (change.kind === 'append' && this.options.follow)) {
      const offset =
        change.kind === 'evict'
          ? change.beforeFrame
          : change.frames.offset + change.frames.count - 1;
      const trace = Object.values(this.data.traces).find(
        (trace) => binding(trace.field, this.data.source, trace.from)?.source === source,
      );
      if (trace) {
        const ref = binding(trace.field, this.data.source, trace.from)!;
        const epoch = this.generation;
        const task = (async () => {
          for await (const part of this.gpu.query(
            source,
            {
              kind: 'samples',
              from: trace.from,
              rows: trace.rows ?? ref.rows,
              select: [ref.field],
              window: { kind: 'frames', offset, count: 1 },
            },
            { signal: this.stop.signal },
          )) {
            if (part.kind === 'schema' || !part.coordinates.length) continue;
            if (epoch !== this.generation) return;
            const coordinate = part.coordinates[0];
              if(change.kind==='evict')this.minimum=Math.max(this.minimum??-Infinity,coordinate);
            this.window = {
              ...this.window,
              between:
                change.kind === 'evict'
                  ? [
                      Math.max(coordinate, this.window.between[0]),
                      Math.max(coordinate, this.window.between[1]),
                    ]
                  : [
                      Math.max(this.data.window.between[0], coordinate - this.options.follow!.span),
                      coordinate,
                    ],
            };
            this.emit('window', this.window);
            break;
          }
        })();
        this.updating = task;
        void task.then(
          () => {
            if (this.updating === task) {
              this.updating = undefined;
              this.refresh();
            }
          },
          (error) => {
            if (this.updating === task) {
              this.updating = undefined;
              this.error = error;
              this.refresh();
            }
          },
        );
      }
    }
    this.refresh();
  }
  private cancel() {
    this.job?.cancel();
    this.focusJob?.cancel();
    this.job = undefined;
    this.focusJob = undefined;
    this.prepared = undefined;
  }
  private restart(debounce: boolean) {
    this.cancel();
    this.setupStop?.abort(new DOMException('Monitor setup superseded', 'AbortError'));
    this.setup = undefined;
    this.dirty = true;
    this.focusDirty = !!this.selected;
    if (this.focusImage) this.focusImage.ready = false;
    this.append = undefined;
    this.generation++;
    this.pickStop?.abort();
    this.error = undefined;
    if (this.debounce) {
      clearTimeout(this.debounce.timer);
      this.debounce.resolve();
      this.debounce = undefined;
    }
    if (debounce) {
      const task = deferred();
      const timer = setTimeout(() => {
        this.debounce = undefined;
        task.resolve();
        this.refresh();
      }, 120);
      this.debounce = { ...task, timer };
    }
    if (!this.closed) this.emit('invalidate', 'replace');
  }
  get pending(): Promise<void> | undefined {
    if (this.closed || this.error) return undefined;
    if (this.debounce) return this.debounce.promise;
    if (this.updating) return this.updating;
    if (this.setup) return this.setup;
    const pending = [this.job?.pending, this.focusJob?.pending].filter(
      (p): p is Promise<void> => !!p,
    );
    if (pending.length) return Promise.race(pending);
    if (this.dirty || this.focusDirty || this.job || this.focusJob || this.append)
      return Promise.resolve();
    return undefined;
  }
  get animating() {
    return (
      !this.closed &&
      !this.debounce &&
      !!(
        this.dirty ||
        this.focusDirty ||
        this.job?.ready ||
        this.job?.done ||
        this.focusJob?.ready ||
        this.focusJob?.done ||
        this.append ||
        this.animate
      )
    );
  }
  private async initialize(signal: AbortSignal) {
    if (this.bindings) return;
    if (!this.setup) {
      const generation = this.generation;
      const control = new AbortController();
      this.setupStop = control;
      const setupSignal = AbortSignal.any([this.stop.signal, control.signal]);
      const task = (async () => {
        const bindings = await describeBindings(this.gpu, this.data, setupSignal);
        let values: Domain | null = null;
        if (this.options.valueDomain === 'auto' && this.autoY)
          for (const item of bindings)
            values = mergeDomain(
              values,
              await extent(
                this.gpu,
                this.data.source,
                item.trace.from,
                item.rows,
                item.fields.value,
                this.window,
                setupSignal,
              ),
            );
        if (generation !== this.generation || this.closed) return;
        this.bindings = bindings;
        if (values && this.autoY) this.y = expanded(values, this.options.domainPadding);
      })();
      this.setup = task;
      void task
        .finally(() => {
          if (this.setup === task) this.setup = undefined;
        })
        .catch(() => {});
    }
    await wait(this.setup, signal);
  }
  private makeImage(): Image {
    const p = plot(this.viewport!, this.options),
      ratio = this.viewport!.pixelRatio;
    const width = Math.max(1, Math.ceil(p.width * ratio)),
      height = Math.max(1, Math.ceil(p.height * ratio));
    const bytes = width * height * 4 * (this.options.msaa === 4 ? 5 : 1);
    if (this.historyBytes() + bytes > this.limits.historyBytes)
      throw new GpuError(
        'resource-limit',
        'Monitor history exceeds historyBytes; reduce viewport, MSAA, or increase its limit',
      );
    return image(this.gpu, width, height, expanded(this.window.between), this.y, this.options.msaa);
  }
  private historyBytes() {
    return (
      [this.front, this.back, this.focusImage].reduce(
        (n, value) => n + (value ? imageBytes(value) : 0),
        0,
      ) +
      (this.job?.seams.bytes ?? this.tails?.bytes ?? 0) +
      (this.focusJob?.seams.bytes ?? 0)
    );
  }
  private start(focus: boolean, frames?: { offset: number; count: number }) {
    const p = plot(this.viewport!, this.options);
    const seed = frames ? this.tails : undefined;
    this.tails = undefined;
    let target: Image;
    if (focus) {
      destroyImage(this.focusImage);
      this.focusImage = undefined;
      target = this.focusImage = this.makeImage();
    } else if (frames && this.front) {
      target = this.front;
    } else {
      destroyImage(this.back);
      this.back = undefined;
      target = this.back = this.makeImage();
    }
    const job = new Job(
      target,
      {
        gpu: this.gpu,
        data: this.data,
        bindings: this.bindings!,
        window: this.window,
        pixels: Math.max(1, Math.floor(p.width * this.viewport!.pixelRatio)),
        detail: this.options.detail,
        limits: this.limits,
        frames,
        focus: focus ? this.selected! : undefined,
      },
      () => this.refresh(),
      seed,
    );
    job.timeMs = this.timeMs;
    job.pointer = this.pointer;
    job.parameters.set(this.parameters);
    if (focus) {
      this.focusJob = job;
      this.focusDirty = false;
    } else {
      this.job = job;
      this.dirty = false;
    }
  }
  async prepare(frame: Preparation) {
    this.live();
    this.prepared = undefined;
    frame.signal.throwIfAborted();
    if (this.error) throw asError(this.error);
    const began = performance.now();
    if (
      this.viewport &&
      (this.viewport.width !== frame.viewport.width ||
        this.viewport.height !== frame.viewport.height ||
        this.viewport.pixelRatio !== frame.viewport.pixelRatio)
    )
      this.restart(false);
    this.viewport = frame.viewport;
    if (this.format !== frame.format) {
      this.format = frame.format;
      this.pipeline = undefined;
      this.compiling = undefined;
    }
    if (!this.pipeline) {
      this.compiling ??= pipelines(this.gpu, frame.format, this.options.msaa, this.shade?.wgsl);
      this.pipeline = await wait(this.compiling, frame.signal);
    }
    if (this.updating) await wait(this.updating, frame.signal);
    await this.initialize(frame.signal);
    if (!this.bindings) {
      this.refresh();
      return;
    }
    if (this.camera) {
      const camera = this.camera;
      this.camera = undefined;
      this.applyCamera(camera);
    }
    if (this.animate && frame.timeMs !== this.timeMs && !this.job && !this.focusJob && !this.dirty) this.dirty = true;
    if (this.dirty && !this.debounce) {
      this.timeMs = frame.timeMs;
      this.animate =
        this.shade?.tick?.(this.parameters, {
          timeMs: frame.timeMs,
          pointerPx: this.pointer,
          viewport: frame.viewport,
        }) ?? false;
      this.start(false);
    }
    if (this.append && !this.job && !this.dirty) {
      const append = this.append;
      this.append = undefined;
      let values: Domain | null = null;
      if (this.options.valueDomain === 'auto' && this.autoY)
        for (const item of this.bindings)
          values = mergeDomain(
            values,
            await extent(
              this.gpu,
              this.data.source,
              item.trace.from,
              item.rows,
              item.fields.value,
              this.options.autoDomain==='fit'?this.window:{ kind: 'frames', offset: append.offset, count: append.count },
              frame.signal,
            ),
          );
      if (
        values &&
        (values[0] < this.y[0] || values[1] > this.y[1] || this.options.autoDomain === 'fit')
      ) {
        this.y = expanded(
          this.options.autoDomain === 'grow' ? mergeDomain(this.y, values)! : values,
          this.options.domainPadding,
        );
        this.start(false);
      } else this.start(false, { offset: append.offset, count: append.count });
    }
    if (this.focusDirty && this.selected && !this.debounce) this.start(true);
    for (const job of [this.job, this.focusJob])
      if (job?.error) {
        this.error = job.error;
        throw asError(job.error);
      }
    const x = expanded(this.window.between),
      key = JSON.stringify([frame.viewport, x, this.y, this.options]);
    if (!this.layout || key !== this.layoutKey) {
      this.layout = await axes(this.gpu, frame.viewport, x, this.y, this.options, frame.signal);
      this.layoutKey = key;
    }
    if (!this.focusImage) this.focusImage = this.makeImage();
    if (!this.front && !this.back) this.back = this.makeImage();
    const painted: { job: Job; draws: Draw[] }[] = [],
      finish: Job[] = [],
      clear: Image[] = [];
    for (const job of [this.job, this.focusJob])
      if (job) {
        if (job.ready) {
          const start = performance.now();
          const draws = prepareChunk(
            this.gpu,
            frame,
            this.pipeline,
            job.ready,
            job.target,
            this.layout.plot,
            this.options,
            job.seams,
            job === this.focusJob,
            job.parameters,
            job.pointer,
            job.memo,
            job.timeMs,
          );
          job.tune(performance.now() - start, this.limits.prepareMs);
          painted.push({ job, draws });
        } else if (job.done) {
          finish.push(job);
          if (job.target.fresh) clear.push(job.target);
        }
      }
    if (this.historyBytes() > this.limits.historyBytes)
      throw new GpuError('resource-limit', 'Monitor history exceeds historyBytes');
    const display = finish.includes(this.job!) ? this.job!.target : (this.front ?? this.back!);
    const focus = this.focusImage;
    const show = display.ready || painted.some((p) => p.job.target === display);
    for (const value of new Set([display, focus, ...painted.map((p) => p.job.target), ...clear])) {
      enroll(frame, value);
      if (value.fresh && !painted.some((p) => p.job.target === value) && !clear.includes(value))
        clear.push(value);
    }
    const screen = await prepareScreen(
      this.gpu,
      frame,
      this.pipeline,
      display,
      focus,
      show,
      !!this.selected && (focus.ready || painted.some((p) => p.job === this.focusJob)),
      x,
      this.y,
      this.layout,
      this.options,
      frame.at,
    );
    frame.signal.throwIfAborted();
    this.prepared = { pipeline: this.pipeline, screen, paint: painted, finish, clear };
    this.prepareMs = performance.now() - began;
  }
  encode(frame: Encoding) {
    if (!this.prepared) return;
    const { pipeline, screen, paint: painted, clear } = this.prepared;
    let calls = 0;
    for (const value of clear) paint(frame, pipeline, value, []);
    for (const item of painted) calls += paint(frame, pipeline, item.job.target, item.draws);
    this.drawCalls = calls + composite(frame, pipeline, screen);
  }
  submitted() {
    const prepared = this.prepared;
    if (!prepared) return;
    this.prepared = undefined;
    this.frames++;
    for (const value of prepared.clear) {
      value.fresh = false;
      value.ready = true;
    }
    for (const { job } of prepared.paint) {
      job.target.fresh = false;
      job.target.ready = true;
      job.consume();
      if(!this.front)this.rowCount=job.rows;
    }
    for (const job of prepared.finish) {
      if (job === this.job) {
        if (job.target !== this.front) {
          destroyImage(this.front);
          this.front = job.target;
          this.back = undefined;
        }
        this.rowCount=job.rows;
        job.seams.finish();
        this.tails = job.seams;
        this.presentedVersions = new Map(job.versions);
        this.job = undefined;
      }
      if (job === this.focusJob) this.focusJob = undefined;
    }
  }
  setData(data: MonitorData) {
    this.live();
    validateData(data);
    this.data = data;
    this.window = windowRange(data.window);
    this.minimum=undefined;
    this.bindings = undefined;
    this.setup = undefined;
    this.autoY = true;
    this.rowCount = 0;
    this.selected = null;
    this.watch();
    this.restart(false);
  }
  setTrace(name:string,patch:Partial<Trace>){
    this.live();if(!this.data.traces[name])fail('Unknown trace '+name);
    const data={...this.data,traces:{...this.data.traces,[name]:{...this.data.traces[name],...patch}}};validateData(data);
    this.data=data;this.bindings=undefined;this.setup=undefined;this.watch();this.restart(false);
  }
  setOptions(patch: Options) {
    this.live();
    const previous = this.options,
      next = settings(previous, patch);
    this.options = next;
    if (
      Object.keys(patch).every((key) => ['hover', 'hoverBudgetMs', 'pickRadiusPx'].includes(key))
    ) {
      this.pickStop?.abort();
      this.hoverState = next.hover === 'off' ? 'off' : 'idle';
      return;
    }
    if (patch.valueDomain !== undefined) {
      this.autoY = true;
      if (next.valueDomain !== 'auto') this.y = expanded(next.valueDomain);
      else {
        this.bindings = undefined;
        this.setup = undefined;
      }
    }
    if (previous.msaa !== next.msaa) {
      this.pipeline = undefined;
      this.compiling = undefined;
      destroyImage(this.front);
      this.front = undefined;
      destroyImage(this.back);
      this.back = undefined;
      destroyImage(this.focusImage);
      this.focusImage = undefined;
    }
    this.hoverState = next.hover === 'off' ? 'off' : 'idle';
    this.restart(false);
  }
  async setShade(value: Shade | null) {
    this.live();
    const next = this.format
      ? await pipelines(this.gpu, this.format, this.options.msaa, value?.wgsl)
      : undefined;
    this.live();
    this.shade = value;
    this.pipeline = next;
    this.compiling = undefined;
    this.parameters.fill(0);
    this.restart(false);
  }
  getCamera(): Camera2D | null {
    if (!this.viewport) return null;
    const p = plot(this.viewport, this.options),
      x = expanded(this.window.between);
    return fitCamera([x[0], this.y[0], x[1], this.y[1]], p, 0, {
      aspect: 'independent',
      yDirection: 'up',
    });
  }
  private applyCamera(camera: Camera2D) {
    if (camera.yDirection !== 'up') fail('Monitor cameras use upward values');
    const p = plot(this.viewport!, this.options),
      a = worldPoint(camera, [0, p.height], p),
      b = worldPoint(camera, [p.width, 0], p);
    this.window = { ...this.window, between: [a[0], b[0]] };
    this.y = expanded([a[1], b[1]]);
    this.autoY = false;
  }
  setCamera(camera: Camera2D) {
    this.live();
    if (!this.viewport) {
      this.camera = camera;
      return;
    }
    this.applyCamera(camera);
    this.restart(true);
    this.emit('window', this.window);
    this.emit('valueDomain', this.y);
    this.emit('fit', false);
  }
  setWindow(value: SampleRange) {
    this.live();
    this.window = windowRange(value);
    this.restart(true);
    this.emit('window', this.window);
    this.emit('fit', false);
  }
  select(item: DataHit | null) {
    this.live();
    if (item && (!Number.isSafeInteger(item.row) || item.row < 0)) fail('Invalid focused row');
    this.selected = item;
    this.focusJob?.cancel();
    this.focusJob = undefined;
    this.focusDirty = !!item;
    if (this.focusImage) this.focusImage.ready = false;
    this.refresh();
  }
  setPointer(point: readonly [number, number] | null) {
    this.live();
    if (point && !point.every(Number.isFinite)) fail('Invalid pointer');
    this.pointer = point;
    this.pickStop?.abort();
    if (this.hoverTask) clearTimeout(this.hoverTask);
    if (this.shade) {
      this.restart(true);
    }
    if (!point || this.options.hover === 'off') {
      this.hoverState = this.options.hover === 'off' ? 'off' : 'idle';
      this.emit('hover', null);
      return;
    }
    if (this.hoverState === 'budget' && this.options.hover === 'auto') return;
    this.hoverTask = setTimeout(() => {
      this.hoverTask = undefined;
      const control = new AbortController();
      this.pickStop = control;
      void this.read(
        point,
        { signal: control.signal, limit: 1 },
        this.options.hover === 'auto' ? this.options.hoverBudgetMs : undefined,
      ).then(
        (hits) => {
          if (!control.signal.aborted) {
            this.hoverState = 'active';
            this.emit('hover', hits[0] ?? null);
          }
        },
        (error) => {
          if (control.signal.aborted) return;
          if (error instanceof HoverBudget) {
            this.hoverState = 'budget';
            this.emit('hover', null);
          } else if (!(error instanceof GpuError && error.code === 'conflict')) {
            this.error = error;
            this.refresh();
          }
        },
      );
    }, 40);
  }
  panBy(dx: number, dy: number) {
    finite(dx, 'pan');
    finite(dy, 'pan');
    const camera = this.getCamera();
    if (camera)
      this.setCamera({
        ...camera,
        center: [camera.center[0] - dx / camera.scale[0], camera.center[1] + dy / camera.scale[1]],
      });
    this.hoverState = 'moving';
  }
  zoomBy(factor: number | readonly [number, number], anchor?: readonly [number, number]) {
    const camera = this.getCamera();
    if (!camera) return;
    const p = plot(this.viewport!, this.options),
      a = anchor
        ? ([anchor[0] - p.x, anchor[1] - p.y] as const)
        : ([p.width / 2, p.height / 2] as const);
    this.setCamera(zoomCamera(camera, factor, a, p));
    this.hoverState = 'idle';
  }
  fit() {
    this.live();
    this.window = windowRange(this.data.window);
    if(this.minimum!==undefined)this.window={...this.window,between:[Math.max(this.minimum,this.window.between[0]),Math.max(this.minimum,this.window.between[1])]};
    this.autoY = true;
    this.bindings = undefined;
    this.setup = undefined;
    this.restart(false);
    this.emit('fit', true);
    this.emit('window', this.window);
  }
  toData(point: readonly [number, number]) {
    const camera = this.getCamera();
    if (!camera) return null;
    const p = plot(this.viewport!, this.options);
    if (point[0] < p.x || point[0] > p.x + p.width || point[1] < p.y || point[1] > p.y + p.height)
      return null;
    const world = worldPoint(camera, [point[0] - p.x, point[1] - p.y], p);
    return { coordinate: world[0], value: world[1] };
  }
  hitTest(point: readonly [number, number], options: HitTestOptions = {}) {
    return this.read(point, options);
  }
  private async read(
    point: readonly [number, number],
    options: HitTestOptions,
    budget?: number,
  ): Promise<readonly Reading[]> {
    this.live();
    if (!this.bindings || !this.layout || !this.toData(point) || !this.front?.ready) return [];
    for (const [source, version] of this.presentedVersions)
      if (source.version !== version)
        throw new GpuError('conflict', 'Monitor history is being updated');
    const generation = this.generation,
      signal = options.signal
        ? AbortSignal.any([options.signal, this.stop.signal])
        : this.stop.signal;
    const result = await pick({
      gpu: this.gpu,
      data: this.data,
      bindings: this.bindings,
      plot: this.layout.plot,
      x: expanded(this.window.between),
      y: this.y,
      point,
      radius: options.radiusPx ?? this.options.pickRadiusPx,
      limit: options.limit ?? 16,
      maxBytes: this.limits.pickingBytes,
      signal,
      budget,
    });
    if (generation !== this.generation)
      throw new DOMException('Presented monitor changed', 'AbortError');
    this.pickingBytes = result.length * 192;
    return result;
  }
  stats(): MonitorStats {
    return {
      traces: this.rowCount,
      historyBytes: this.historyBytes(),
      pickingBytes: this.pickingBytes,
      prepareMs: this.prepareMs,
      drawCalls: this.drawCalls,
      frames: this.frames,
      refining: !!this.pending,
      hover: this.hoverState,
    };
  }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.stop.abort(new DOMException('Monitor destroyed', 'AbortError'));
    this.cancel();
    this.pickStop?.abort();
    if (this.hoverTask) clearTimeout(this.hoverTask);
    if (this.debounce) {
      clearTimeout(this.debounce.timer);
      this.debounce.resolve();
    }
    for (const dispose of this.subscriptions) dispose();
    this.subscriptions = [];
    for (const value of new Set([this.front, this.back, this.focusImage])) destroyImage(value);
    this.front = this.back = this.focusImage = undefined;
    this.tails = undefined;
    this.presentedVersions.clear();
    this.listeners.clear();
    interactions.delete(this);
  }
}
