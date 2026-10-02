import type { Domain, Queryable, Update } from '@latkit/model';
import { GpuError, kit, type Gpu, type Shade, type View } from '@latkit/gpu';
import { monitorData, type MonitorData, type Reading, type Trace } from './data.js';
import type { Limits, StyleOptions } from './options.js';
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
import { attachInput, type MonitorInput } from './input.js';

type Point = readonly [number, number];
/** What the monitor shows. */
export interface Camera {
  /** Coordinates shown, such as seconds. */
  readonly window: Domain;
  /** Values shown. */
  readonly values: Domain;
  /** Fit the values to the data as it changes. */
  readonly fit: boolean;
  /** Show the latest coordinates as frames append, this span wide; null stays put. */
  readonly follow: number | null;
}
export interface MonitorConfig extends kit.ViewConfig, StyleOptions {
  /** Borrowed sampled data, such as a Recording: destroy never closes it. */
  readonly source: Queryable;
  /** Lines by name; several may read one type. */
  readonly traces: Readonly<Record<string, Trace>>;
  /** Where the camera starts; `monitor.camera` is where it is. Values fit the data by default. */
  readonly camera: Partial<Camera> & { readonly window: Domain };
  /** Pointer and keyboard inspection of the canvas; `inspect` by default. */
  readonly input?: NonNullable<MonitorInput['mode']> | MonitorInput;
  /** WGSL that recolors every fragment. */
  readonly shade?: Shade | null;
  readonly limits?: Limits;
}
export interface MonitorEvents extends kit.ViewEvents {
  readonly hover: Reading | null;
  /** The user changed the selection. */
  readonly select: readonly Reading[];
  readonly contextmenu: kit.ContextMenu<Reading>;
  /** The presented camera changed, such as by following appends. */
  readonly camera: Camera;
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
  readonly hover: kit.HoverState;
}
export interface PickOptions {
  readonly radiusPx?: number;
  /** Nearest observations, ordered by distance; default 16. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
type Records = 'traces';
type Merged = 'camera' | 'input' | 'limits';
/** At draws the playhead. */
export interface Monitor extends View<MonitorConfig, MonitorEvents> {
  set(
    patch: kit.Patch<MonitorConfig, 'traces', 'camera' | 'input' | 'limits'>,
    options?: kit.SetOptions,
  ): void;
  /** What is shown. `set({ camera })` changes it. */
  readonly camera: Camera;
  /** Highlighted rows; a hit with a field narrows to that field's trace. */
  readonly selection: readonly kit.DataHit[];
  select(items: readonly kit.DataHit[]): void;
  /** Exact observations near a canvas point, nearest first. */
  pick(point: readonly [x: number, y: number], options?: PickOptions): Promise<readonly Reading[]>;
  /** A reading's canvas point, or null when it is not shown. */
  locate(item: Reading): readonly [x: number, y: number] | null;
  /** Show the readings, or all recorded frames with fitted values. */
  fit(items?: readonly Reading[], options?: kit.SetOptions): void;
  /** Move the window just enough to show the reading. */
  reveal(item: Reading, options?: kit.SetOptions): void;
  stats(): MonitorStats;
}

/** Draw sampled fields over a coordinate such as time, on a canvas or offscreen. */
export function createMonitor(gpu: Gpu, config: MonitorConfig): Monitor {
  return new MonitorView(gpu, config);
}
const KEYS = new Set([
  'canvas',
  'at',
  'paused',
  'source',
  'traces',
  'camera',
  'input',
  'shade',
  'limits',
  ...Object.keys(defaults),
]);
interface Resolved {
  readonly config: MonitorConfig;
  readonly options: Settings;
  readonly limits: Required<Limits>;
}
function resolve(config: MonitorConfig): Resolved {
  for (const key of Object.keys(config)) if (!KEYS.has(key)) fail('Unknown monitor option: ' + key);
  validateData(monitorData(config, { kind: 'range', between: [0, 1] }));
  return { config, options: settings(config), limits: limits(config.limits) };
}
function follows(value: number | null): number | null {
  if (value !== null && (!Number.isFinite(value) || value <= 0)) fail('Invalid follow span');
  return value;
}
class MonitorView extends kit.BaseView<MonitorConfig, MonitorEvents, Records, Merged> {
  private data: MonitorData;
  private options: Settings;
  private limits: Required<Limits>;
  private resolved?: Resolved;
  private readonly stop = new AbortController();
  private closed = false;
  private follow: number | null;
  private fitValues: boolean;
  private reported?: Camera;
  private shadeSerial = 0;
  private subscriptions: (() => void)[] = [];
  private bindings?: Binding[];
  private setup?: Promise<void>;
  private setupStop?: AbortController;
  private error?: unknown;
  private window: import('@latkit/model').SampleRange;
  private y: Domain;
  private viewport?: kit.Viewport;
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
  private chosen: readonly kit.DataHit[] = Object.freeze([]);
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
  private hoverState: kit.HoverState = 'idle';
  private hoverTask?: ReturnType<typeof setTimeout>;
  private frames = 0;
  private drawCalls = 0;
  private prepareMs = 0;
  private rowCount = 0;
  private pickingBytes = 0;
  constructor(gpu: Gpu, config: MonitorConfig) {
    super(gpu, config, { records: ['traces'], merged: ['camera', 'input', 'limits'] });
    const resolved = resolve(this.config),
      camera = config.camera ?? fail('A monitor needs a camera window');
    this.options = resolved.options;
    this.limits = resolved.limits;
    this.window = windowRange(camera.window);
    this.data = monitorData(this.config, this.window);
    this.follow = follows(camera.follow ?? null);
    this.fitValues = camera.fit ?? !camera.values;
    this.y = camera.values && !this.fitValues ? expanded(camera.values) : [0, 1];
    this.shade = config.shade ?? null;
    this.watch();
    this.start();
  }
  private refresh() {
    this.invalidate('refresh');
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
      this.clearSelection();
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
      this.follow ||
      this.fitValues
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
      this.begin(false, { offset, count });
      if (this.chosen.length) this.begin(true);
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
    this.focusDirty = this.chosen.length > 0;
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
    if (notify) this.invalidate('replace');
  }
  protected get pending(): Promise<void> | undefined {
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
  protected get animating(): boolean {
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
        if (this.fitValues)
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
  private begin(focus: boolean, frames?: { offset: number; count: number }) {
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
        focus: focus ? this.chosen : undefined,
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
  protected async prepare(frame: kit.Preparation): Promise<void> {
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
      this.focusDirty = this.chosen.length > 0;
    }
    if (this.dirty && !this.debounce) {
      this.timeMs = frame.timeMs;
      this.animate =
        this.shade?.tick?.(this.parameters, {
          timeMs: frame.timeMs,
          pointerPx: this.pointer,
          viewport: frame.viewport,
        }) ?? false;
      this.begin(false);
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
      if (this.follow) {
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
              between: [Math.max(this.data.window.between[0], end - this.follow), end],
            };
            break;
          }
      }
      let values: Domain | null = null;
      if (this.fitValues)
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
      this.focusDirty = this.chosen.length > 0;
      if (
        values &&
        (values[0] < this.y[0] || values[1] > this.y[1] || this.options.autoDomain === 'fit')
      ) {
        this.y = expanded(
          this.options.autoDomain === 'grow' ? mergeDomain(this.y, values)! : values,
          this.options.domainPadding,
        );
        this.begin(false);
      } else this.begin(false, this.follow ? undefined : append);
    }
    if (this.focusDirty && this.chosen.length && !this.focusJob && !this.debounce) this.begin(true);
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
      (!this.chosen.length ||
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
      (!replacementReady || this.chosen.length > 0) &&
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
  protected encode(frame: kit.Encoding): void {
    if (!this.prepared) return;
    const { pipeline, screen, paint: painted, clear } = this.prepared;
    let calls = 0;
    for (const value of clear) paint(frame, pipeline, value, []);
    for (const item of painted) calls += paint(frame, pipeline, item.job.target, item.draws);
    this.drawCalls = calls + composite(frame, pipeline, screen);
  }
  protected submitted(): void {
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
      if (!this.chosen.length) {
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
    this.report();
  }
  get camera(): Camera {
    return Object.freeze({
      window: this.window.between,
      values: this.y,
      fit: this.fitValues,
      follow: this.follow,
    });
  }
  get selection(): readonly kit.DataHit[] {
    return this.chosen;
  }
  select(items: readonly kit.DataHit[]): void {
    this.live();
    for (const item of items)
      if (!Number.isSafeInteger(item.row) || item.row < 0) fail('Invalid focused row');
    this.chosen = Object.freeze([...items]);
    this.focusJob?.cancel();
    this.focusJob = undefined;
    destroyImage(this.focusBack);
    this.focusBack = undefined;
    this.focusDirty = items.length > 0;
    if (!items.length) this.focusVisible = false;
    if (items.length && this.bindings && this.viewport && !this.dirty && !this.debounce)
      this.begin(true);
    this.refresh();
  }
  fit(items?: readonly Reading[], options: kit.SetOptions = {}): void {
    this.live();
    if (!items?.length) {
      const range = (this.data.source as { readonly range?: Domain | null }).range;
      this.moveCamera(range ? { window: range, fit: true } : { fit: true }, options);
      return;
    }
    let lo = Infinity,
      hi = -Infinity,
      low = Infinity,
      high = -Infinity;
    for (const item of items) {
      lo = Math.min(lo, item.coordinate);
      hi = Math.max(hi, item.coordinate);
      low = Math.min(low, item.value);
      high = Math.max(high, item.value);
    }
    const half = (this.window.between[1] - this.window.between[0]) / 2;
    this.moveCamera(
      {
        window: hi > lo ? expanded([lo, hi], this.options.domainPadding) : [lo - half, lo + half],
        values: expanded([low, high], this.options.domainPadding),
      },
      options,
    );
  }
  reveal(item: Reading, options: kit.SetOptions = {}): void {
    this.live();
    const [lo, hi] = this.window.between;
    if (item.coordinate >= lo && item.coordinate <= hi) return;
    const half = (hi - lo) / 2;
    this.moveCamera({ window: [item.coordinate - half, item.coordinate + half] }, options);
  }
  locate(item: Reading): Point | null {
    if (!this.front || !this.presented) return null;
    const p = this.presented.layout.plot,
      { x, y } = this.front;
    const point: Point = [
      p.x + ((item.coordinate - x[0]) / (x[1] - x[0])) * p.width,
      p.y + ((y[1] - item.value) / (y[1] - y[0])) * p.height,
    ];
    return this.toData(point) ? point : null;
  }
  pick(point: Point, options: PickOptions = {}): Promise<readonly Reading[]> {
    return this.read(point, options);
  }

  protected check(config: MonitorConfig): void {
    this.resolved = resolve(config);
  }
  protected configure(previous: MonitorConfig, next: MonitorConfig): void {
    const resolved = this.resolved?.config === next ? this.resolved : resolve(next);
    this.resolved = undefined;
    const before = this.options;
    this.options = resolved.options;
    this.limits = resolved.limits;
    if (previous.source !== next.source || previous.traces !== next.traces) {
      this.data = monitorData(next, this.window);
      this.bindings = undefined;
      this.setup = undefined;
      if (previous.source !== next.source) {
        this.rowCount = 0;
        this.through.clear();
        this.clearSelection();
      }
      this.watch();
    }
    if (previous.shade !== next.shade) this.compile(next.shade ?? null);
    const changed = (Object.keys(defaults) as (keyof Settings)[]).filter(
      (key) => before[key] !== this.options[key],
    );
    const hoverOnly = changed.every((key) =>
      ['hover', 'hoverBudgetMs', 'pickRadiusPx'].includes(key),
    );
    this.hoverState = this.options.hover === 'off' ? 'off' : 'idle';
    if (
      hoverOnly &&
      previous.source === next.source &&
      previous.traces === next.traces &&
      previous.limits === next.limits
    ) {
      this.pickStop?.abort();
      return;
    }
    if (before.msaa !== this.options.msaa) {
      this.pipeline = undefined;
      this.compiling = undefined;
    }
    this.restart(false);
  }
  /** Null shows all recorded frames with fitted values. */
  protected moveCamera(patch: Partial<Camera> | null, options: kit.SetOptions = {}): void {
    void options;
    if (patch === null) {
      this.fit();
      return;
    }
    if (patch.window) {
      this.window = windowRange(patch.window);
      this.follow = null;
    }
    if (patch.follow !== undefined) this.follow = follows(patch.follow);
    if (patch.values) {
      this.y = expanded(patch.values);
      this.fitValues = false;
    }
    if (patch.fit !== undefined && patch.fit !== this.fitValues) {
      this.fitValues = patch.fit;
      if (patch.fit) {
        this.bindings = undefined;
        this.setup = undefined;
      }
    }
    this.restart(false);
  }
  protected attach(canvas: HTMLCanvasElement): () => void {
    return attachInput(canvas, (this.config.input ?? {}) as MonitorInput, {
      pointer: (point) => this.point(point),
      pick: (point, options) => this.read(point, options),
      choose: (items) => {
        this.select(items);
        this.emit('select', items);
      },
      menu: (menu) => this.emit('contextmenu', menu),
    });
  }
  private clearSelection(): void {
    if (!this.chosen.length) return;
    this.select([]);
    this.emit('select', []);
  }
  private compile(shade: Shade | null): void {
    const serial = ++this.shadeSerial,
      format = this.format;
    (format
      ? pipelines(this.gpu, format, this.options.msaa, shade?.wgsl)
      : Promise.resolve(undefined)
    ).then(
      (next) => {
        if (serial !== this.shadeSerial || this.closed) return;
        this.shade = shade;
        this.pipeline = next;
        this.compiling = undefined;
        this.parameters.fill(0);
        this.restart(false);
      },
      (error: unknown) => {
        if (serial === this.shadeSerial) this.fail(error);
      },
    );
  }
  /** Report the presented camera when it moved. */
  private report(): void {
    const camera = this.camera,
      last = this.reported;
    if (
      last &&
      last.window[0] === camera.window[0] &&
      last.window[1] === camera.window[1] &&
      last.values[0] === camera.values[0] &&
      last.values[1] === camera.values[1] &&
      last.fit === camera.fit &&
      last.follow === camera.follow
    )
      return;
    this.reported = camera;
    this.emit('camera', camera);
  }
  /** Move the pointer; hover reads are debounced and one at a time. */
  private point(point: Point | null) {
    if (this.closed) return;
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
          if (!this.closed && this.pointer && this.pointer !== point) this.point(this.pointer);
        });
    }, 16);
  }
  private toData(point: Point) {
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
  private async read(
    point: readonly [number, number],
    options: PickOptions,
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
  protected release(): void {
    this.closed = true;
    this.shadeSerial++;
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
  }
}
