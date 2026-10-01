import type { Domain, RequestOptions, SampleRange, Queryable, Update } from '@latkit/model';
import type {
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
}
export interface MonitorStats {
  readonly traces: number;
  readonly historyBytes: number;
  readonly pickingBytes: number;
  readonly pendingBytes: number;
  readonly visible: boolean;
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
  setTrace(name: string, patch: Partial<Trace>): void;
  setOptions(options: Options): void;
  setShade(shade: Shade | null): Promise<void>;
  setWindow(window: SampleRange): void;
  /** Focus a native row; field narrows focus when supplied. Does not emit select. */
  select(item: DataHit | null): void;
  setPointer(point: readonly [number, number] | null): void;
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
  readonly options?: Options;
  readonly limits?: Limits;
  readonly shade?: Shade;
}

import { GpuError, type Preparation, type Encoding, type FrameInfo } from '@latkit/gpu';
import {
  defaults,
  settings,
  limits,
  expanded,
  windowRange,
  fail,
  type Settings,
} from './config.js';
import { binding, describeBindings, validateData, extent, type Binding } from './bindings.js';
import { axes, plot, type Axes } from './axes.js';
import { mergeDomain } from './history.js';
import { Job } from './job.js';
import { Sources } from './sources.js';
import { Coverage } from './coverage.js';
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
  private focusBack?: Image;
  private focusVisible = false;
  private presented?: { data: MonitorData; bindings: Binding[]; options: Settings; layout: Axes };
  private presentation = 0;
  private invalidSources = new Set<Queryable>();
  private job?: Job;
  private readonly sources = new Sources();
  private coverage = new Coverage();
  private through = new Map<Queryable, number>();
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
  private append = new Map<Queryable, { offset: number; count: number }>();
  private generation = 0;
  private presentedVersions = new Map<Queryable, string>();
  private prepared?: {
    pipeline: Pipelines;
    screen: Screen;
    paint: { job: Job; draws: Draw[]; count: number }[];
    clear: Image[];
    finish: Job[];
    layout: Axes;
    commit: boolean;
    initial: boolean;
  };
  private pickStop?: AbortController;
  private hovering = false;
  private inspection?: {
    point: readonly [number, number];
    radius: number;
    limit: number;
    generation: number;
    presentation: number;
    versions: Map<Queryable, string>;
    result: readonly Reading[];
  };
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
    this.sources.prune(sources);
    for (const source of sources)
      this.subscriptions.push(source.on('change', (change) => this.update(source, change)));
  }
  private update(source: Queryable, change: Update) {
    if (this.closed || change.kind === 'status') return;
    if (change.kind === 'append') {
      const previous = this.append.get(source),
        start = Math.min(previous?.offset ?? change.frames.offset, change.frames.offset);
      const end = Math.max(
        previous ? previous.offset + previous.count : 0,
        change.frames.offset + change.frames.count,
      );
      this.append.set(source, { offset: start, count: end - start });
      this.prefetchAppend();
      this.refresh();
      return;
    }
    this.pickStop?.abort();
    this.generation++;
    if (change.kind === 'closed') {
      this.error = new GpuError('closed', 'A monitor source closed');
      this.cancel();
      this.refresh();
      return;
    }
    if (change.kind === 'replace') {
      this.invalidSources.add(source);
      this.select(null);
      this.through.clear();
    }
    this.bindings = undefined;
    this.setup = undefined;
    this.generation++;
    this.error = undefined;
    this.restart(false);
    this.refresh();
  }
  private prefetchAppend() {
    if (
      this.closed ||
      this.job ||
      this.focusJob ||
      this.dirty ||
      this.debounce ||
      !this.front ||
      !this.bindings ||
      this.options.follow ||
      this.options.valueDomain === 'auto'
    )
      return;
    const next = this.append.entries().next().value;
    if (!next) return;
    const [source, range] = next;
    if (!this.bindings.every((b) => b.source === source)) return;
    this.append.delete(source);
    const offset = Math.max(range.offset, (this.through.get(source) ?? -Infinity) + 1),
      count = range.offset + range.count - offset;
    if (count <= 0) return;
    try {
      this.start(false, { offset, count });
      if (this.selected) this.start(true);
    } catch (error) {
      this.error = error;
    }
  }
  private cancel() {
    this.job?.cancel();
    this.focusJob?.cancel();
    this.job = undefined;
    this.focusJob = undefined;
    this.prepared = undefined;
    destroyImage(this.back);
    this.back = undefined;
    destroyImage(this.focusBack);
    this.focusBack = undefined;
  }
  private restart(debounce: boolean, notify = true) {
    this.cancel();
    this.setupStop?.abort(new DOMException('Monitor setup superseded', 'AbortError'));
    this.setup = undefined;
    this.dirty = true;
    this.focusDirty = !!this.selected;
    this.append.clear();
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
    if (notify && !this.closed) this.emit('invalidate', 'replace');
  }
  get pending(): Promise<void> | undefined {
    if (this.closed || this.error) return undefined;
    if (this.debounce) return this.debounce.promise;
    if (this.setup) return this.setup;
    if (this.job?.ready || this.focusJob?.ready) return Promise.resolve();
    const pending = [this.job?.pending, this.focusJob?.pending].filter(
      (p): p is Promise<void> => !!p,
    );
    if (pending.length) return Promise.race(pending);
    if (this.dirty || this.focusDirty || this.job || this.focusJob || this.append.size)
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
        (this.job?.done && (!this.focusJob || this.focusJob.done)) ||
        this.focusJob?.ready ||
        (this.focusJob?.done && (!this.job || this.job.done)) ||
        this.append.size ||
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
        if (this.options.valueDomain === 'auto')
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
        if (values) this.y = expanded(values, this.options.domainPadding);
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
      [this.front, this.back, this.focusImage, this.focusBack].reduce(
        (n, value) => n + (value ? imageBytes(value) : 0),
        0,
      ) +
      (this.job?.seams.bytes ?? this.tails?.bytes ?? 0) +
      (this.focusJob?.seams.bytes ?? 0) +
      (this.job?.bytes ?? 0) +
      (this.focusJob?.bytes ?? 0) +
      this.coverage.bytes
    );
  }
  private start(focus: boolean, frames?: { offset: number; count: number }) {
    const p = plot(this.viewport!, this.options);
    const seed = frames ? this.tails : undefined;
    if (!focus) this.tails = undefined;
    let target: Image;
    if (focus) {
      destroyImage(this.focusBack);
      this.focusBack = undefined;
      target = this.focusBack = this.makeImage();
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
      this.sources,
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
      this.restart(!!this.front, false);
    this.viewport = frame.viewport;
    if (this.format !== frame.format) {
      this.format = frame.format;
      this.pipeline = undefined;
      this.compiling = undefined;
    }
    if (!this.pipeline)
      this.compiling ??= pipelines(this.gpu, frame.format, this.options.msaa, this.shade?.wgsl);
    await this.initialize(frame.signal);
    if (!this.bindings) {
      this.refresh();
      return;
    }
    if (
      this.animate &&
      frame.timeMs !== this.timeMs &&
      !this.job &&
      !this.focusJob &&
      !this.dirty
    ) {
      this.dirty = true;
      this.focusDirty = !!this.selected;
    }
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
    if (this.append.size && !this.job && !this.focusJob && !this.dirty) {
      const [source, range] = this.append.entries().next().value!;
      this.append.delete(source);
      const offset = Math.max(range.offset, (this.through.get(source) ?? -Infinity) + 1);
      const append = { offset, count: Math.max(0, range.offset + range.count - offset) };
      if (!append.count) {
        this.refresh();
        return;
      }
      if (this.options.follow) {
        const item = this.bindings.find((b) => b.source === source);
        if (item)
          for await (const block of this.gpu.query(
            source,
            {
              kind: 'samples',
              from: item.trace.from,
              rows: item.rows,
              select: [item.field],
              window: { kind: 'frames', offset: append.offset + append.count - 1, count: 1 },
            },
            { signal: frame.signal },
          )) {
            if (block.kind === 'schema' || !block.coordinates.length) continue;
            const end = block.coordinates[0];
            this.window = {
              ...this.window,
              between: [Math.max(this.data.window.between[0], end - this.options.follow.span), end],
            };
            this.emit('window', this.window);
            break;
          }
      }
      let values: Domain | null = null;
      if (this.options.valueDomain === 'auto')
        for (const item of this.bindings)
          values = mergeDomain(
            values,
            await extent(
              this.gpu,
              this.data.source,
              item.trace.from,
              item.rows,
              item.fields.value,
              this.options.autoDomain === 'fit'
                ? this.window
                : { kind: 'frames', offset: append.offset, count: append.count },
              frame.signal,
            ),
          );
      this.focusDirty = !!this.selected;
      if (
        values &&
        (values[0] < this.y[0] || values[1] > this.y[1] || this.options.autoDomain === 'fit')
      ) {
        this.y = expanded(
          this.options.autoDomain === 'grow' ? mergeDomain(this.y, values)! : values,
          this.options.domainPadding,
        );
        this.start(false);
      } else this.start(false, this.options.follow ? undefined : append);
    }
    if (this.focusDirty && this.selected && !this.focusJob && !this.debounce) this.start(true);
    for (const job of [this.job, this.focusJob])
      if (job?.error) {
        this.error = job.error;
        throw asError(job.error);
      }
    if (!this.front && !this.back) this.back = this.makeImage();
    if (!this.pipeline) this.pipeline = await wait(this.compiling!, frame.signal);
    const painted: { job: Job; draws: Draw[]; count: number }[] = [],
      finish: Job[] = [],
      clear: Image[] = [];
    const deadline = began + this.limits.prepareMs;
    let observations = 0;
    // Focus first, then history; one shared preparation/observation budget.
    for (const job of [this.focusJob, this.job])
      if (job) {
        const draws: Draw[] = [];
        let count = 0;
        for (const entry of job.queue) {
          if (
            (count || painted.length) &&
            (performance.now() >= deadline ||
              observations + entry.observations > this.limits.segmentsPerFrame)
          )
            break;
          const start = performance.now();
          draws.push(
            ...prepareChunk(
              this.gpu,
              frame,
              this.pipeline,
              entry.chunk,
              job.target,
              plot(frame.viewport, this.options),
              this.options,
              job.seams,
              job === this.focusJob,
              job.parameters,
              job.pointer,
              entry.memo,
              job.timeMs,
            ),
          );
          job.tune(performance.now() - start, this.limits.prepareMs);
          count++;
          observations += entry.observations;
        }
        if (count) painted.push({ job, draws, count });
      }
    const replacementReady =
      !!this.job?.completeAfter(painted.find((p) => p.job === this.job)?.count ?? 0) &&
      (!this.selected ||
        !!this.focusJob?.completeAfter(painted.find((p) => p.job === this.focusJob)?.count ?? 0) ||
        (!this.focusDirty && !this.focusJob));
    const x = replacementReady || !this.front ? expanded(this.window.between) : this.front.x;
    const y = replacementReady || !this.front ? this.y : this.front.y;
    const displayOptions =
      replacementReady || !this.presented ? this.options : this.presented.options;
    const key = JSON.stringify([frame.viewport, x, y, displayOptions]);
    if (!this.layout || key !== this.layoutKey) {
      this.layout = await axes(this.gpu, frame.viewport, x, y, displayOptions, frame.signal);
      this.layoutKey = key;
    }
    for (const job of [this.job, this.focusJob])
      if (
        job &&
        job.completeAfter(painted.find((p) => p.job === job)?.count ?? 0) &&
        (!this.job || replacementReady)
      ) {
        finish.push(job);
        if (job.target.fresh && !painted.some((p) => p.job === job)) clear.push(job.target);
      }
    if (this.historyBytes() > this.limits.historyBytes)
      throw new GpuError('resource-limit', 'Monitor history exceeds historyBytes');
    const display = replacementReady ? this.job!.target : (this.front ?? this.back!);
    const focusReady = finish.includes(this.focusJob!);
    const focus = focusReady ? this.focusJob!.target : (this.focusImage ?? display);
    const initial = !this.front && painted.some((p) => p.job === this.job);
    const show = !!this.front || replacementReady || initial;
    const showFocus =
      (focusReady || this.focusVisible) &&
      (!replacementReady || !!this.selected) &&
      focus.x[0] === display.x[0] &&
      focus.x[1] === display.x[1] &&
      focus.y[0] === display.y[0] &&
      focus.y[1] === display.y[1];
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
      showFocus,
      x,
      y,
      this.layout,
      displayOptions,
      frame.at,
    );
    frame.signal.throwIfAborted();
    this.prepared = {
      pipeline: this.pipeline,
      screen,
      paint: painted,
      finish,
      clear,
      layout: this.layout,
      commit: replacementReady,
      initial,
    };
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
    }
    for (const { job, count } of prepared.paint) {
      job.target.fresh = false;
      if (job === this.job && job.target === this.front && this.coverage !== job.coverage)
        for (const item of job.queue.slice(0, count)) this.coverage.add(item.chunk);
      job.consume(count);
      if (!this.front) this.rowCount = job.rows;
    }
    if (prepared.initial && this.job) {
      this.front = this.job.target;
      this.front.ready = true;
      this.back = undefined;
      this.coverage = this.job.coverage;
    }
    if (
      prepared.commit ||
      prepared.initial ||
      prepared.paint.some((p) => p.job.target === this.front) ||
      this.presented?.layout !== prepared.layout
    )
      this.presentation++;
    if (prepared.commit || prepared.initial) {
      this.invalidSources.clear();
      this.presented = {
        data: this.data,
        bindings: this.bindings!,
        options: this.options,
        layout: prepared.layout,
      };
      if (!this.selected) {
        destroyImage(this.focusImage);
        this.focusImage = undefined;
        this.focusVisible = false;
      }
    } else if (this.presented) this.presented.layout = prepared.layout;
    for (const job of prepared.finish) {
      job.target.ready = true;
      if (job === this.job) {
        if (job.target !== this.front) {
          destroyImage(this.front);
          this.front = job.target;
          this.coverage = job.coverage;
          this.back = undefined;
        }
        this.rowCount = job.rows;
        for (const [source, end] of job.endFrames)
          this.through.set(source, Math.max(this.through.get(source) ?? -Infinity, end));
        job.seams.finish();
        this.tails = job.seams;
        this.presentedVersions = new Map(job.versions);
        this.job = undefined;
      }
      if (job === this.focusJob) {
        destroyImage(this.focusImage);
        this.focusImage = job.target;
        this.focusVisible = true;
        this.focusBack = undefined;
        this.focusJob = undefined;
      }
    }
    this.prefetchAppend();
  }
  setData(data: MonitorData) {
    this.live();
    validateData(data);
    this.data = data;
    this.window = windowRange(data.window);
    this.bindings = undefined;
    this.setup = undefined;
    this.rowCount = 0;
    this.through.clear();
    this.selected = null;
    this.watch();
    this.restart(false);
  }
  setTrace(name: string, patch: Partial<Trace>) {
    this.live();
    if (!this.data.traces[name]) fail('Unknown trace ' + name);
    const data = {
      ...this.data,
      traces: { ...this.data.traces, [name]: { ...this.data.traces[name], ...patch } },
    };
    validateData(data);
    this.data = data;
    this.bindings = undefined;
    this.setup = undefined;
    this.watch();
    this.restart(false);
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
      if (next.valueDomain !== 'auto') this.y = expanded(next.valueDomain);
      else {
        this.bindings = undefined;
        this.setup = undefined;
      }
    }
    if (previous.msaa !== next.msaa) {
      this.pipeline = undefined;
      this.compiling = undefined;
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
  setWindow(value: SampleRange) {
    this.live();
    this.window = windowRange(value);
    this.restart(false);
    this.emit('window', this.window);
  }
  select(item: DataHit | null) {
    this.live();
    if (item && (!Number.isSafeInteger(item.row) || item.row < 0)) fail('Invalid focused row');
    this.selected = item;
    this.focusJob?.cancel();
    this.focusJob = undefined;
    destroyImage(this.focusBack);
    this.focusBack = undefined;
    this.focusDirty = !!item;
    if (!item) this.focusVisible = false;
    if (item && this.bindings && this.viewport && !this.dirty && !this.debounce) this.start(true);
    this.refresh();
  }
  setPointer(point: readonly [number, number] | null) {
    this.live();
    if (point && !point.every(Number.isFinite)) fail('Invalid pointer');
    this.pointer = point;
    if (!point || this.options.hover === 'off') {
      this.pickStop?.abort();
      if (this.hoverTask) clearTimeout(this.hoverTask);
      this.hoverTask = undefined;
      this.hoverState = this.options.hover === 'off' ? 'off' : 'idle';
      this.emit('hover', null);
      return;
    }
    if (this.hoverState === 'budget' && this.options.hover === 'auto') return;
    if (this.hoverTask || this.hovering) return;
    this.hoverTask = setTimeout(() => {
      this.hoverTask = undefined;
      const point = this.pointer;
      if (!point) return;
      const control = new AbortController();
      this.pickStop = control;
      this.hovering = true;
      void this.read(
        point,
        { signal: control.signal, limit: 1 },
        this.options.hover === 'auto' ? this.options.hoverBudgetMs : undefined,
      )
        .then(
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
        )
        .finally(() => {
          this.hovering = false;
          if (!this.closed && this.pointer && this.pointer !== point) this.setPointer(this.pointer);
        });
    }, 16);
  }
  toData(point: readonly [number, number]) {
    if (!this.front || !this.presented) return null;
    const p = this.presented.layout.plot,
      { x, y } = this.front;
    if (point[0] < p.x || point[0] > p.x + p.width || point[1] < p.y || point[1] > p.y + p.height)
      return null;
    return {
      coordinate: x[0] + ((point[0] - p.x) / p.width) * (x[1] - x[0]),
      value: y[1] - ((point[1] - p.y) / p.height) * (y[1] - y[0]),
    };
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
    if (!this.presented || !this.toData(point) || !this.front?.ready) return [];
    if (this.invalidSources.size)
      throw new GpuError('conflict', 'Presented observations have been replaced');
    options.signal?.throwIfAborted();
    const radius = options.radiusPx ?? this.options.pickRadiusPx,
      limit = options.limit ?? 16;
    const versions = new Map(this.presented.bindings.map((b) => [b.source, b.source.version]));
    const cached = this.inspection;
    if (
      cached &&
      cached.point[0] === point[0] &&
      cached.point[1] === point[1] &&
      cached.radius === radius &&
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      cached.limit >= limit &&
      cached.generation === this.generation &&
      cached.presentation === this.presentation &&
      [...versions].every(([s, v]) => cached.versions.get(s) === v)
    )
      return cached.result.slice(0, limit);
    const generation = this.generation,
      presentation = this.presentation,
      signal = options.signal
        ? AbortSignal.any([options.signal, this.stop.signal])
        : this.stop.signal;
    const result = await pick({
      gpu: this.gpu,
      data: this.presented.data,
      bindings: this.presented.bindings,
      plot: this.presented.layout.plot,
      x: this.front.x,
      y: this.front.y,
      point,
      radius: options.radiusPx ?? this.options.pickRadiusPx,
      limit: options.limit ?? 16,
      maxBytes: this.limits.pickingBytes,
      signal,
      budget,
      accepts: (reading) => this.coverage.contains(reading),
    });
    if (generation !== this.generation || presentation !== this.presentation)
      throw new DOMException('Presented monitor changed', 'AbortError');
    this.pickingBytes = result.length * 192;
    if ([...versions].every(([s, v]) => s.version === v))
      this.inspection = {
        point: [...point],
        radius,
        limit,
        generation,
        presentation,
        versions,
        result,
      };
    return result;
  }
  stats(): MonitorStats {
    return {
      traces: this.rowCount,
      historyBytes: this.historyBytes(),
      pickingBytes: this.pickingBytes,
      pendingBytes: (this.job?.bytes ?? 0) + (this.focusJob?.bytes ?? 0),
      visible: !!this.front?.ready,
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
    this.sources.destroy();
    this.inspection = undefined;
    this.pickStop?.abort();
    if (this.hoverTask) clearTimeout(this.hoverTask);
    if (this.debounce) {
      clearTimeout(this.debounce.timer);
      this.debounce.resolve();
    }
    for (const dispose of this.subscriptions) dispose();
    this.subscriptions = [];
    for (const value of new Set([this.front, this.back, this.focusImage, this.focusBack]))
      destroyImage(value);
    this.front = this.back = this.focusImage = this.focusBack = undefined;
    this.tails = undefined;
    this.presentedVersions.clear();
    this.listeners.clear();
    interactions.delete(this);
  }
}
