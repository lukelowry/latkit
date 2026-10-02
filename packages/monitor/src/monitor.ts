import {
  GpuError,
  kit,
  viewStyle,
  type DataHit,
  type Gpu,
  type ItemEvents,
  type ItemView,
  type ItemViewConfig,
  type Point,
  type SetOptions,
  type Shade,
  type ViewInput,
  type ViewStats,
} from '@latkit/gpu';
import {
  sameIndex,
  sampleDomain,
  samplePages,
  type Data,
  type Domain,
  type RowAxis,
  type SampleRange,
  type SampleWindow,
} from '@latkit/model';
import { Tiles, coordinateRanges } from './tiles.js';
import {
  FIELD_OPTIONS,
  appended,
  mergeRanges,
  monitorData,
  type FrameRanges,
  type FrameRange,
  type MonitorData,
  type Reading,
  type Trace,
} from './data.js';
import type { Limits, MonitorStyle } from './options.js';
import {
  DEFAULTS,
  VIEW_DEFAULTS,
  resolveStyle,
  limits,
  expanded,
  windowRange,
  fail,
  type Style,
} from './config.js';
import {
  DEFAULT_CAMERA,
  checkCamera,
  mixCamera,
  move,
  sameDomain,
  zoom,
  type Camera,
} from './camera.js';
import { binding, describeBindings, validateData, type Binding } from './bindings.js';
import { axes, plot, type Axes } from './axes.js';
import { mergeDomain } from './history.js';
import { Job, deferred } from './job.js';
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
import { pick, READING_BYTES } from './picking.js';
import type { Seams } from './segments.js';
import { listen, type Gestures } from './input.js';

export interface MonitorConfig extends ItemViewConfig, MonitorStyle {
  /** Lines by name; several may read one type. */
  readonly traces: Readonly<Record<string, Trace>>;
  /** Where the camera starts; `monitor.camera` is where it is. Values fit the data by default. */
  readonly camera: Partial<Camera> & { readonly window: Domain };
  readonly limits?: Limits;
}
export type MonitorEvents = ItemEvents<DataHit, Reading, Camera>;
export interface MonitorStats extends ViewStats {
  /** Rows the history draws. */
  readonly rows: number;
  readonly historyBytes: number;
  readonly pendingBytes: number;
  /** Whether history is drawn. */
  readonly visible: boolean;
  /** Whether history is still being read or drawn. */
  readonly refining: boolean;
}
type Records = 'traces';
type Merged = 'camera' | 'input' | 'limits';
/**
 * Selects rows, each narrowed to one trace when it names a `field`, and picks exact readings.
 * `at` draws the playhead.
 */
export interface Monitor extends ItemView<MonitorConfig, DataHit, Reading, Camera, MonitorEvents> {
  set(patch: kit.Patch<MonitorConfig, Records, Merged>, options?: SetOptions): void;
  stats(): MonitorStats;
}

/** Draw sampled fields over a coordinate such as time, on a canvas or offscreen. */
export function createMonitor(gpu: Gpu, config: MonitorConfig): Monitor {
  return new MonitorView(gpu, config);
}
const STYLE_KEYS = [...Object.keys(viewStyle), ...Object.keys(DEFAULTS)] as (keyof Style)[];
const KEYS = new Set<string>([
  'canvas',
  'at',
  'paused',
  'source',
  'traces',
  'camera',
  'input',
  'shade',
  'limits',
  ...STYLE_KEYS,
]);
/** Style that changes no history pixels: hover, picking, camera motion, and fitting. */
const INSPECTION = new Set<keyof Style>([
  'hover',
  'hoverBudgetMs',
  'pickRadiusPx',
  'revealPaddingPx',
  'fitPaddingPx',
  'animationMs',
  'motion',
  'hoverColor',
  'hoverWidthPx',
  'domainPadding',
]);
interface Resolved {
  readonly config: MonitorConfig;
  readonly limits: Required<Limits>;
}
function resolve(config: MonitorConfig): Resolved {
  for (const key of Object.keys(config)) if (!KEYS.has(key)) fail('Unknown monitor option: ' + key);
  validateData(monitorData(config, { kind: 'range', between: [0, 1] }));
  resolveStyle(config, viewStyle);
  return { config, limits: limits(config.limits) };
}
/** The window and values that show readings: their coordinates and values, padded. */
function frameReadings(
  items: readonly DataHit[],
  camera: Camera,
  padding: number,
): Partial<Camera> {
  let lo = Infinity,
    hi = -Infinity,
    low = Infinity,
    high = -Infinity;
  for (const item of items) {
    const coordinate = item.coordinate,
      value = (item as Partial<Reading>).value;
    if (coordinate !== undefined && Number.isFinite(coordinate)) {
      lo = Math.min(lo, coordinate);
      hi = Math.max(hi, coordinate);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  const half = (camera.window[1] - camera.window[0]) / 2;
  return {
    ...(lo <= hi
      ? {
          window: hi > lo ? expanded([lo, hi], padding) : ([lo - half, lo + half] as Domain),
          follow: null,
        }
      : {}),
    ...(low <= high ? { values: expanded([low, high], padding) } : {}),
  };
}
function includes(rows: RowAxis, row: number): boolean {
  return rows.kind === 'range'
    ? row >= rows.offset && row < rows.offset + rows.count
    : rows.values.includes(row);
}
/** What the latest committed frame drew: what pick, locate, and hover read. */
interface Shown {
  readonly data: MonitorData;
  readonly bindings: Binding[];
  readonly style: Style;
  layout: Axes;
}

class MonitorView
  extends kit.BaseItemView<MonitorConfig, MonitorEvents, DataHit, Reading, Camera, Records, Merged>
  implements Monitor
{
  protected readonly framed = ['values'] as const;
  protected readonly inputMode = 'inspect';
  private data: MonitorData;
  private style: Style;
  private limits: Required<Limits>;
  private resolved?: Resolved;
  private readonly stop = new AbortController();
  private bindings?: Binding[];
  private setup?: Promise<void>;
  private setupStop?: AbortController;
  private error?: unknown;
  /** The coordinates and values history is drawn for. */
  private window: SampleRange;
  private y: Domain;
  /** Values fitted to the data over a window, kept while the data stands. */
  private fitted?: { readonly window: Domain; readonly values: Domain | null };
  private measuring?: {
    readonly data: MonitorData;
    readonly window: Domain;
    readonly promise: Promise<Domain | null>;
  };
  /** The frame whose camera is being framed. */
  private preparing?: kit.Preparation;
  /** Whether the latest prepared camera fitted values. */
  private fitDrawn = false;
  private viewport?: kit.Viewport;
  private layout?: Axes;
  private layoutKey = '';
  private pipeline?: Pipelines;
  private compiling?: {
    readonly format: GPUTextureFormat;
    readonly msaa: 1 | 4;
    readonly shade: Shade | null;
    readonly promise: Promise<Pipelines>;
  };
  /** The shade history is drawn with. */
  private drawnShade: Shade | null;
  private parameters = new Float32Array(64);
  private animate = false;
  private timeMs = 0;
  private front?: Image;
  private back?: Image;
  private focusImage?: Image;
  private focusBack?: Image;
  private focusVisible = false;
  private shown?: Shown;
  private presentation = 0;
  private job?: Job;
  private coverage = new Coverage();
  private focusJob?: Job;
  private tails?: Seams;
  private tiles: Tiles;
  private dirty = true;
  private focusDirty = false;
  /** The selection the focus image draws. */
  private focused: readonly DataHit[];
  private debounce?: {
    promise: Promise<void>;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private append = new Map<string, readonly FrameRange[]>();
  private generation = 0;
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
  private inspection?: {
    point: Point;
    radius: number;
    limit: number;
    generation: number;
    presentation: number;
    result: readonly Reading[];
  };
  private drawCalls = 0;
  private rowCount = 0;
  private pickingBytes = 0;
  private readonly gestures: Gestures = {
    pan: (dx, dy) => this.pan(dx, dy),
    click: (point, signal) =>
      void this.read(point, this.viewStyle.pickRadiusPx, 1, signal).then(
        (hits) => {
          if (!signal.aborted && !this.closed) this.choose(hits.slice(0, 1));
        },
        (error: unknown) => {
          if (!signal.aborted && !this.closed) this.fail(error);
        },
      ),
  };
  /** The hover search: exact readings, a frame later. */
  private readonly nearest: kit.HoverSearch<Reading> = (point, radius, { signal }) => {
    if (!this.shown || !this.front?.ready || !this.toData(point)) return null;
    const found = this.read(point, radius, 1, signal).then((hits) => hits[0] ?? null);
    // A search past its budget is dropped; its failure is then no one's.
    found.catch(() => {});
    return found;
  };
  constructor(gpu: Gpu, config: MonitorConfig) {
    super(
      gpu,
      config,
      { records: ['traces'], merged: ['camera', 'input', 'limits'], fields: FIELD_OPTIONS },
      VIEW_DEFAULTS,
    );
    if (!config.camera?.window) fail('A monitor needs a camera window');
    this.limits = resolve(this.config).limits;
    this.style = resolveStyle(this.config, this.viewStyle);
    this.tiles = new Tiles(this.limits.historyBytes / 4);
    const camera = this.camera;
    this.window = windowRange(camera.window);
    this.y = camera.values;
    this.data = monitorData(this.config, this.window);
    this.drawnShade = this.shade;
    this.focused = this.selection;
    this.start();
  }

  stats(): MonitorStats {
    return {
      ...super.stats(),
      rows: this.rowCount,
      historyBytes: this.historyBytes(),
      pendingBytes: (this.job?.bytes ?? 0) + (this.focusJob?.bytes ?? 0),
      visible: !!this.front?.ready,
      refining: !!this.pending,
      pickingBytes: this.pickingBytes,
      drawCalls: this.drawCalls,
    };
  }
  /** Readings frame once; no readings fit the values and show every recorded coordinate. */
  fit(items?: readonly DataHit[], options: SetOptions = {}): void {
    this.live();
    if (!items?.length) {
      const recorded = this.recorded();
      if (recorded) this.moveCamera({ window: recorded }, options);
    }
    super.fit(items, options);
  }

  // ── Camera ──
  protected defaultCamera(): Camera {
    return DEFAULT_CAMERA;
  }
  protected resolveCamera(camera: Camera): Camera {
    return checkCamera(camera);
  }
  protected framing(
    items: readonly DataHit[] | undefined,
    camera: Camera,
  ): Partial<Camera> | undefined | Promise<Partial<Camera> | undefined> {
    if (items) return frameReadings(items, camera, this.style.domainPadding);
    const fitted = this.fitted;
    if (fitted && sameDomain(fitted.window, camera.window))
      return fitted.values ? { values: fitted.values } : undefined;
    return this.extent(camera.window);
  }
  protected interpolate(from: Camera, to: Camera, t: number): Camera {
    return mixCamera(from, to, t);
  }
  protected panned(camera: Camera, dx: number, dy: number, viewport: kit.Viewport): Camera {
    return move(camera, dx, dy, plot(viewport, this.style));
  }
  protected zoomed(camera: Camera, factor: number, anchor: Point, viewport: kit.Viewport): Camera {
    return zoom(camera, factor, anchor, plot(viewport, this.style));
  }
  /** Moving the window by hand stops following, unless the same move follows. */
  protected moveCamera(patch: Readonly<Record<string, unknown>> | null, options: SetOptions): void {
    super.moveCamera(
      patch && 'window' in patch && !('follow' in patch) ? { ...patch, follow: null } : patch,
      options,
    );
  }

  // ── Items ──
  /** A reading's point in the latest committed frame; it lies off the plot outside the window. */
  protected position(item: DataHit): Point | null {
    const shown = this.shown,
      front = this.front,
      value = (item as Partial<Reading>).value;
    if (!shown || !front || item.coordinate === undefined || typeof value !== 'number') return null;
    const p = shown.layout.plot,
      { x, y } = front;
    return [
      p.x + ((item.coordinate - x[0]) / (x[1] - x[0])) * p.width,
      p.y + ((y[1] - value) / (y[1] - y[0])) * p.height,
    ];
  }
  protected identify(item: DataHit): string {
    return JSON.stringify([
      item.index.source,
      item.index.type,
      item.index.version,
      item.row,
      item.field ?? null,
      item.frame ?? null,
      (item as Partial<Reading>).trace ?? null,
    ]);
  }
  protected accept(item: DataHit): void {
    if (!Number.isSafeInteger(item.row) || item.row < 0) fail('Invalid selected row');
    if (!this.table(item)) throw new GpuError('conflict', 'Selection belongs to another source');
  }
  /** Rows stay selected while a trace draws them and their row space stands, as through appends. */
  protected contains(item: DataHit): boolean {
    const rows = this.table(item)?.rows;
    if (!rows || !includes(rows, item.row)) return false;
    const name = (item as Partial<Reading>).trace,
      traces = this.config.traces;
    return (name === undefined ? Object.values(traces) : [traces[name]]).some(
      (trace) =>
        trace?.from === item.index.type &&
        (!item.field ||
          item.field === (typeof trace.field === 'string' ? trace.field : trace.field.field)) &&
        (!trace.rows || trace.rows.kind === 'ids' || includes(trace.rows, item.row)),
    );
  }
  /** The nearest `limit` readings, capped by what the picking budget holds. */
  protected hits(
    point: Point,
    radiusPx: number,
    options: { readonly limit: number; readonly signal?: AbortSignal },
  ): Promise<readonly Reading[]> {
    const capacity = Math.max(1, Math.floor(this.limits.pickingBytes / READING_BYTES));
    return this.read(point, radiusPx, Math.min(options.limit, capacity), options.signal);
  }
  protected compileShade(shade: Shade | null, format: GPUTextureFormat): Promise<unknown> {
    return pipelines(this.gpu, format, this.viewStyle.msaa, shade?.wgsl);
  }
  protected listen(
    canvas: HTMLCanvasElement,
    input: kit.CanvasInput,
    mode: NonNullable<ViewInput['mode']>,
  ): void {
    listen(canvas, input, mode, this.gestures);
  }

  // ── Config ──
  protected check(config: MonitorConfig): void {
    super.check(config);
    this.resolved = resolve(config);
  }
  protected configure(previous: MonitorConfig, next: MonitorConfig): void {
    const resolved = this.resolved?.config === next ? this.resolved : resolve(next);
    this.resolved = undefined;
    this.style = resolveStyle(next, this.viewStyle);
    this.limits = resolved.limits;
    const restyled = STYLE_KEYS.filter(
      (key) => previous[key as keyof MonitorConfig] !== next[key as keyof MonitorConfig],
    );
    const addition =
      previous.source !== next.source &&
      previous.traces === next.traces &&
      previous.limits === next.limits &&
      previous.shade === next.shade &&
      !restyled.length
        ? appended(previous.source, next.source)
        : undefined;
    if (
      addition &&
      this.bindings?.every(
        (binding) =>
          binding.source === previous.source &&
          typeof binding.trace.field === 'string' &&
          [binding.trace.color?.field, binding.trace.visible, binding.trace.shade].every(
            (input) =>
              !input ||
              typeof input !== 'object' ||
              !('field' in input && input.source === previous.source),
          ),
      )
    ) {
      this.data = monitorData(next, this.window);
      this.bindings = this.bindings.map((item) => ({
        ...item,
        source: next.source,
        fields: Object.fromEntries(
          Object.entries(item.fields).map(([name, value]) => [
            name,
            typeof value === 'object' && 'field' in value && value.source === previous.source
              ? { ...value, source: next.source }
              : value,
          ]),
        ),
      }));
      for (const binding of this.bindings) {
        const fields = new Set([binding.field]);
        for (const value of Object.values(binding.fields)) {
          if (typeof value === 'string') fields.add(value);
          else if (
            'field' in value &&
            value.source === next.source &&
            value.from === binding.trace.from
          )
            fields.add(value.field);
        }
        const ranges = [...fields].flatMap(
          (field) => addition.get(binding.trace.from + ':' + field) ?? [],
        );
        if (ranges.length)
          this.append.set(
            binding.name,
            mergeRanges([...(this.append.get(binding.name) ?? []), ...ranges]),
          );
      }
      this.prefetchAppend();
      this.invalidate();
      return;
    }
    const redata = previous.source !== next.source || previous.traces !== next.traces;
    if (redata) {
      this.tiles.clear();
      this.data = monitorData(next, this.window);
      this.bindings = undefined;
      this.setup = undefined;
      this.fitted = undefined;
      this.measuring = undefined;
      if (previous.source !== next.source) this.rowCount = 0;
    }
    if (previous.traces !== next.traces) this.pruneSelection();
    if (previous.limits !== next.limits) this.tiles = new Tiles(this.limits.historyBytes / 4);
    if (previous.traces !== next.traces || previous.detail !== next.detail) this.tiles.clear();
    if (previous.domainPadding !== next.domainPadding) this.fitted = undefined;
    // A shade redraws history once it compiles; input and inspection style redraw nothing.
    if (
      !redata &&
      previous.limits === next.limits &&
      restyled.every((key) => INSPECTION.has(key))
    ) {
      this.invalidate();
      return;
    }
    this.restart(false);
  }

  // ── Frames ──
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
      super.animating ||
      (!this.closed &&
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
        ))
    );
  }
  protected async prepare(frame: kit.Preparation): Promise<void> {
    this.live();
    this.prepared = undefined;
    frame.signal.throwIfAborted();
    if (this.error) throw this.error as Error;
    const began = performance.now(),
      work = new kit.Work(frame.signal);
    if (
      this.viewport &&
      (this.viewport.width !== frame.viewport.width ||
        this.viewport.height !== frame.viewport.height ||
        this.viewport.pixelRatio !== frame.viewport.pixelRatio)
    )
      this.restart(!!this.front, false);
    this.viewport = frame.viewport;
    const shade = this.shade;
    if (shade !== this.drawnShade) {
      // A compiled shade replaces the history drawn with the previous one.
      this.drawnShade = shade;
      this.parameters.fill(0);
      this.tiles.clear();
      this.restart(false, false);
    }
    const msaa = this.style.msaa,
      compiling = this.compiling;
    if (
      !compiling ||
      compiling.format !== frame.format ||
      compiling.msaa !== msaa ||
      compiling.shade !== shade
    ) {
      this.pipeline = undefined;
      this.compiling = {
        format: frame.format,
        msaa,
        shade,
        promise: pipelines(this.gpu, frame.format, msaa, shade?.wgsl),
      };
      void this.compiling.promise.catch(() => {});
    }
    await this.initialize(work);
    if (!this.bindings) {
      this.invalidate();
      return;
    }
    const selection = this.selection;
    if (selection !== this.focused) {
      this.focused = selection;
      this.focusJob?.cancel();
      this.focusJob = undefined;
      destroyImage(this.focusBack);
      this.focusBack = undefined;
      this.focusDirty = selection.length > 0;
      if (!selection.length) this.focusVisible = false;
    }
    // Turning fit on reads the values afresh.
    if (this.camera.fit && !this.fitDrawn) this.fitted = undefined;
    this.preparing = frame;
    let camera: Camera;
    try {
      camera = await this.frameCamera(frame);
    } finally {
      this.preparing = undefined;
    }
    const target = this.camera;
    this.fitDrawn = camera.fit;
    if (!sameDomain(camera.window, this.window.between) || !sameDomain(camera.values, this.y)) {
      this.window = windowRange(camera.window);
      this.y = camera.values;
      this.restart(false, false);
    }
    if (
      this.animate &&
      frame.timeMs !== this.timeMs &&
      !this.job &&
      !this.focusJob &&
      !this.dirty
    ) {
      this.dirty = true;
      this.focusDirty = this.focused.length > 0;
    }
    if (this.dirty && !this.debounce) {
      this.timeMs = frame.timeMs;
      this.animate =
        shade?.tick?.(this.parameters, {
          timeMs: frame.timeMs,
          pointerPx: this.pointerPoint,
          viewport: frame.viewport,
        }) ?? false;
      this.begin(false);
    }
    if (this.append.size && !this.job && !this.focusJob && !this.dirty) {
      // Snapshot the request without consuming it. A cancelled await must leave it retryable.
      const frames = new Map(this.append),
        style = this.style;
      let window = this.window;
      if (camera.follow) {
        // Appends land at the tail, so the newest coordinate is each field's last.
        let end = -Infinity;
        for (const item of this.bindings)
          if (frames.get(item.name)?.length)
            end = Math.max(
              end,
              sampleDomain(item.source.tables[item.trace.from]?.fields[item.field])?.[1] ??
                -Infinity,
            );
        if (Number.isFinite(end))
          window = {
            ...window,
            between: [Math.max(this.data.window.between[0], end - camera.follow), end],
          };
      }
      let values: Domain | null = null;
      if (camera.fit)
        for (const item of this.bindings) {
          const cached =
            style.autoDomain === 'fit'
              ? await this.tiles.bounds(item.name, window.between, frame.signal)
              : undefined;
          let windows: SampleWindow[];
          if (cached) {
            values = mergeDomain(values, cached.domain);
            const intervals = [...cached.missing];
            const pages = item.source.tables[item.trace.from]?.fields[item.field];
            if (pages)
              for (const range of frames.get(item.name) ?? [])
                for (const page of samplePages(pages, { kind: 'frames', ...range })) {
                  const sample = page.samples;
                  if (!sample) continue;
                  const start = Math.max(range.offset, sample.firstFrame),
                    end = Math.min(
                      range.offset + range.count,
                      sample.firstFrame + sample.coordinates.length,
                    );
                  if (start >= end) continue;
                  const first = Math.max(
                    window.between[0],
                    sample.coordinates[start - sample.firstFrame],
                  );
                  const last = Math.min(
                    window.between[1],
                    sample.coordinates[end - sample.firstFrame - 1],
                  );
                  if (first <= last) intervals.push([first, last]);
                }
            windows = coordinateRanges(intervals).map((between) => ({ kind: 'range', between }));
          } else
            windows =
              style.autoDomain === 'fit'
                ? [window]
                : (frames.get(item.name) ?? []).map((range) => ({
                    kind: 'frames' as const,
                    ...range,
                  }));
          for (const selected of windows)
            values = mergeDomain(
              values,
              await frame.reader.extent({
                source: this.data.source,
                from: item.trace.from,
                rows: item.rows,
                field: item.fields.value,
                window: selected,
              }),
            );
        }
      frame.signal.throwIfAborted();
      this.window = window;
      this.focusDirty = this.focused.length > 0;
      if (
        values &&
        (values[0] < this.y[0] || values[1] > this.y[1] || style.autoDomain === 'fit')
      ) {
        this.y = expanded(
          style.autoDomain === 'grow' ? mergeDomain(this.y, values)! : values,
          style.domainPadding,
        );
        this.begin(false, frames, true);
      } else this.begin(false, frames, !!camera.follow);
      // The durable job now owns preparation; frame cancellation does not cancel that job.
      this.append.clear();
      if (camera.fit) this.fitted = { window: this.window.between, values: this.y };
      if (!sameDomain(this.window.between, camera.window) || !sameDomain(this.y, camera.values)) {
        // Following appends and fitting their values move the camera.
        const moved = checkCamera({ ...camera, window: this.window.between, values: this.y });
        this.drawCamera(frame, moved);
        if (this.camera === target)
          this.moveCamera(
            {
              window: moved.window,
              values: moved.values,
              fit: moved.fit,
              follow: moved.follow,
            },
            {},
          );
      }
    }

    if (this.focusDirty && this.focused.length && !this.focusJob && !this.debounce)
      this.begin(true);
    for (const job of [this.job, this.focusJob])
      if (job?.error) {
        this.error = job.error;
        throw job.error as Error;
      }
    if (!this.front && !this.back) this.back = this.makeImage();
    if (!this.pipeline) this.pipeline = await work.wait(this.compiling!.promise);
    const painted: { job: Job; draws: Draw[]; count: number }[] = [],
      finish: Job[] = [],
      clear: Image[] = [];
    const deadline = began + this.limits.frameMs;
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
              observations + entry.observations > this.limits.observationsPerFrame)
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
              plot(frame.viewport, this.style),
              this.style,
              job.seams,
              job === this.focusJob,
              job.parameters,
              job.pointer,
              entry.memo,
              job.timeMs,
            ),
          );
          job.tune(performance.now() - start, this.limits.frameMs);
          count++;
          observations += entry.observations;
        }
        if (count) painted.push({ job, draws, count });
      }
    const replacementReady =
      !!this.job?.completeAfter(painted.find((p) => p.job === this.job)?.count ?? 0) &&
      (!this.focused.length ||
        !!this.focusJob?.completeAfter(painted.find((p) => p.job === this.focusJob)?.count ?? 0) ||
        (!this.focusDirty && !this.focusJob));
    const x = replacementReady || !this.front ? expanded(this.window.between) : this.front.x;
    const y = replacementReady || !this.front ? this.y : this.front.y;
    const displayed = replacementReady || !this.shown ? this.style : this.shown.style;
    const key = JSON.stringify([frame.viewport, x, y, displayed]);
    if (!this.layout || key !== this.layoutKey) {
      this.layout = await axes(this.gpu, frame.viewport, x, y, displayed, frame.signal);
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
      (!replacementReady || this.focused.length > 0) &&
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
      displayed,
      frame.at,
    );
    frame.signal.throwIfAborted();
    this.hoverFrame(frame, this.nearest);
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
  }
  protected discard(): void {
    this.prepared = undefined;
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
    for (const value of prepared.clear) {
      value.fresh = false;
    }
    for (const { job, count } of prepared.paint) {
      job.target.fresh = false;
      if (job === this.job && job.target === this.front && this.coverage !== job.coverage)
        for (const item of job.queue.slice(0, count)) this.coverage.add(item.chunk);
      if (job === this.job)
        for (const entry of job.queue.slice(0, count))
          if (!entry.cached) this.tiles.add(entry, this.window.between);
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
      this.shown?.layout !== prepared.layout
    )
      this.presentation++;
    if (prepared.commit || prepared.initial) {
      this.shown = {
        data: this.data,
        bindings: this.bindings!,
        style: this.style,
        layout: prepared.layout,
      };
      if (!this.focused.length) {
        destroyImage(this.focusImage);
        this.focusImage = undefined;
        this.focusVisible = false;
      }
    } else if (this.shown) this.shown.layout = prepared.layout;
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
        this.tiles.finish(
          this.window.between,
          Math.max(
            1,
            Math.floor(plot(this.viewport!, this.style).width * this.viewport!.pixelRatio),
          ),
          job.rows,
          true,
        );
        job.seams.finish();
        this.tails = job.seams;
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
  protected release(): void {
    this.tiles.clear();
    this.stop.abort(new DOMException('Monitor destroyed', 'AbortError'));
    this.cancelJobs();
    this.inspection = undefined;
    this.measuring = undefined;
    if (this.debounce) {
      clearTimeout(this.debounce.timer);
      this.debounce.resolve();
    }
    for (const value of new Set([this.front, this.back, this.focusImage, this.focusBack]))
      destroyImage(value);
    this.front = this.back = this.focusImage = this.focusBack = undefined;
    this.tails = undefined;
    this.shown = undefined;
  }

  // ── History ──
  private prefetchAppend() {
    const camera = this.camera;
    if (
      this.closed ||
      this.job ||
      this.focusJob ||
      this.dirty ||
      this.debounce ||
      !this.front ||
      !this.bindings ||
      !this.append.size ||
      camera.follow ||
      camera.fit ||
      !sameDomain(camera.window, this.window.between) ||
      !sameDomain(camera.values, this.y)
    )
      return;
    const frames = new Map(this.append);
    try {
      this.begin(false, frames);
      this.append.clear();
      if (this.focused.length) this.begin(true);
    } catch (error) {
      this.error = error;
    }
  }
  private cancelJobs() {
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
    this.cancelJobs();
    this.setupStop?.abort(new DOMException('Monitor setup superseded', 'AbortError'));
    this.setup = undefined;
    this.dirty = true;
    this.focusDirty = this.focused.length > 0;
    this.append.clear();
    this.generation++;
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
        this.invalidate();
      }, 120);
      this.debounce = { ...task, timer };
    }
    if (notify) this.invalidate();
  }
  private async initialize(work: kit.Work) {
    if (this.bindings) return;
    if (!this.setup) {
      const generation = this.generation;
      const control = new AbortController();
      this.setupStop = control;
      const signal = AbortSignal.any([this.stop.signal, control.signal]);
      const task = (async () => {
        const reads = this.gpu.reader.open({ signal });
        try {
          const bindings = await describeBindings(reads, this.data);
          if (generation !== this.generation || this.closed) return;
          this.bindings = bindings;
        } finally {
          reads.close();
        }
      })();
      this.setup = task;
      void task
        .finally(() => {
          if (this.setup === task) this.setup = undefined;
        })
        .catch(() => {});
    }
    await work.wait(this.setup);
  }
  /** Values fitted to the data over a window, read once and kept while the data stands. */
  private async extent(window: Domain): Promise<Partial<Camera> | undefined> {
    const bindings = this.bindings,
      data = this.data,
      signal = this.preparing?.signal;
    if (!bindings || !signal) return undefined;
    let task = this.measuring;
    if (!task || task.data !== data || !sameDomain(task.window, window)) {
      const promise = (async () => {
        const reads = this.gpu.reader.open({ signal: this.stop.signal });
        try {
          let values: Domain | null = null;
          for (const item of bindings)
            values = mergeDomain(
              values,
              await reads.extent({
                source: data.source,
                from: item.trace.from,
                rows: item.rows,
                field: item.fields.value,
                window: { kind: 'range', between: window },
              }),
            );
          return values;
        } finally {
          reads.close();
        }
      })();
      task = this.measuring = { data, window, promise };
      void promise.catch(() => {
        if (this.measuring?.promise === promise) this.measuring = undefined;
      });
    }
    const values = await new kit.Work(signal).wait(task.promise);
    if (this.measuring === task) this.measuring = undefined;
    const fitted = values && expanded(values, this.style.domainPadding);
    if (this.data === data) this.fitted = { window, values: fitted };
    return fitted ? { values: fitted } : undefined;
  }
  private makeImage(): Image {
    const p = plot(this.viewport!, this.style),
      ratio = this.viewport!.pixelRatio;
    const width = Math.max(1, Math.ceil(p.width * ratio)),
      height = Math.max(1, Math.ceil(p.height * ratio));
    const bytes = width * height * 4 * (this.style.msaa === 4 ? 5 : 1);
    if (this.historyBytes() + bytes > this.limits.historyBytes)
      throw new GpuError(
        'resource-limit',
        'Monitor history exceeds historyBytes; reduce viewport, MSAA, or increase its limit',
      );
    return image(this.gpu, width, height, expanded(this.window.between), this.y, this.style.msaa);
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
      this.tiles.bytes +
      this.coverage.bytes
    );
  }
  private begin(focus: boolean, frames?: FrameRanges, reproject = false) {
    const p = plot(this.viewport!, this.style);
    const pixels = Math.max(1, Math.floor(p.width * this.viewport!.pixelRatio));
    const cached =
      !focus && (!frames || reproject)
        ? this.tiles.reuse(this.window.between, pixels, this.bindings!, !!frames)
        : undefined;
    if (
      cached &&
      frames &&
      this.tiles.coveredThrough !== undefined &&
      this.window.between[1] > this.tiles.coveredThrough
    ) {
      // A camera extension may expose existing observations, not only newly appended ones.
      const pending = new Map(frames),
        through = this.tiles.coveredThrough;
      const exposed: SampleWindow = {
        kind: 'range',
        between: [Math.max(through, this.window.between[0]), this.window.between[1]],
      };
      for (const binding of this.bindings!) {
        const ranges = [...(pending.get(binding.name) ?? [])];
        const pages = binding.source.tables[binding.trace.from]?.fields[binding.field];
        if (pages)
          for (const page of samplePages(pages, exposed)) {
            const sample = page.samples;
            if (!sample) continue;
            const coordinates = sample.coordinates;
            if (coordinates.at(-1)! <= through || coordinates[0] > this.window.between[1]) continue;
            const bound = (value: number, inclusive: boolean) => {
              let lo = 0,
                hi = coordinates.length;
              while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (coordinates[mid] < value || (!inclusive && coordinates[mid] === value))
                  lo = mid + 1;
                else hi = mid;
              }
              return lo;
            };
            const first = bound(
              Math.max(through, this.window.between[0]),
              this.window.between[0] > through,
            );
            const end = bound(this.window.between[1], false);
            if (first < end) ranges.push({ offset: sample.firstFrame + first, count: end - first });
          }
        if (ranges.length) pending.set(binding.name, mergeRanges(ranges));
      }
      frames = pending;
    }
    if (reproject && !cached) frames = undefined;
    const seed = frames || cached ? this.tails : undefined;
    if (!focus) {
      this.tails = undefined;
      if (!frames && !cached) this.tiles.clear();
    }
    let target: Image;
    if (focus) {
      destroyImage(this.focusBack);
      this.focusBack = undefined;
      target = this.focusBack = this.makeImage();
    } else if (frames && this.front && !reproject) {
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
        pixels,
        detail: this.style.detail,
        limits: this.limits,
        frames,
        focus: focus ? this.focused : undefined,
      },
      () => this.invalidate(),
      seed,
      cached
        ? { entries: cached, rows: this.tiles.rows, readNew: !!frames }
        : frames
          ? { entries: [], rows: this.rowCount, readNew: true }
          : undefined,
    );
    job.timeMs = this.timeMs;
    job.pointer = this.pointerPoint;
    job.parameters.set(this.parameters);
    if (focus) {
      this.focusJob = job;
      this.focusDirty = false;
    } else {
      this.job = job;
      this.dirty = false;
    }
  }
  /** Every recorded coordinate of every trace. */
  private recorded(): Domain | null {
    let recorded: Domain | null = null;
    for (const trace of Object.values(this.data.traces)) {
      const main = binding(trace.field, this.data.source, trace.from);
      if (main)
        recorded = mergeDomain(
          recorded,
          sampleDomain(main.source.tables[main.from]?.fields[main.field]),
        );
    }
    return recorded;
  }

  // ── Inspection ──
  private toData(point: Point) {
    if (!this.front || !this.shown) return null;
    const p = this.shown.layout.plot,
      { x, y } = this.front;
    if (point[0] < p.x || point[0] > p.x + p.width || point[1] < p.y || point[1] > p.y + p.height)
      return null;
    return {
      coordinate: x[0] + ((point[0] - p.x) / p.width) * (x[1] - x[0]),
      value: y[1] - ((point[1] - p.y) / p.height) * (y[1] - y[0]),
    };
  }
  /** Exact readings near a point in the latest committed frame, nearest first. */
  private async read(
    point: Point,
    radius: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly Reading[]> {
    this.live();
    const shown = this.shown,
      front = this.front;
    if (!shown || !front?.ready || !this.toData(point)) return [];
    signal?.throwIfAborted();
    // The latest answer at this point stands while what it read is still shown.
    const cached = this.inspection;
    if (
      cached &&
      cached.point[0] === point[0] &&
      cached.point[1] === point[1] &&
      cached.radius === radius &&
      cached.limit >= limit &&
      cached.generation === this.generation &&
      cached.presentation === this.presentation
    )
      return cached.result.length > limit ? cached.result.slice(0, limit) : cached.result;
    const generation = this.generation,
      presentation = this.presentation;
    const reads = this.gpu.reader.open({
      signal: signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal,
    });
    let result: Reading[];
    try {
      result = await pick({
        reads,
        data: shown.data,
        bindings: shown.bindings,
        plot: shown.layout.plot,
        x: front.x,
        y: front.y,
        point,
        radius,
        limit,
        accepts: (reading) => this.coverage.contains(reading),
      });
    } finally {
      reads.close();
    }
    this.pickingBytes = result.length * READING_BYTES;
    // An answer is reused only while what it read is still shown.
    if (generation === this.generation && presentation === this.presentation)
      this.inspection = {
        point: [point[0], point[1]],
        radius,
        limit,
        generation,
        presentation,
        result,
      };
    return result;
  }
  /** The table of an item's rows among the sources the traces read. */
  private table(item: DataHit): Data['tables'][string] | undefined {
    const config = this.config,
      sources = new Set([config.source]);
    for (const trace of Object.values(config.traces))
      if (typeof trace.field === 'object') sources.add(trace.field.source);
    for (const source of sources) {
      const table = source.tables[item.index?.type];
      if (table && sameIndex(table.index, item.index)) return table;
    }
    return undefined;
  }
}
