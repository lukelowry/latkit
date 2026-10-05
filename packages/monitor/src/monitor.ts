import {
  kit,
  type Gpu,
  type ItemEvents,
  type ItemView,
  type ItemViewConfig,
  type Point,
  type SetOptions,
  type Shade,
  type ViewStats,
  type FrameInfo,
  type Patch,
  type Viewport,
} from '@latkit/gpu';
import {
  Work,
  failure,
  rowCount,
  sameIndex,
  sampleDomain,
  sampleFrames,
  type Data,
  type Domain,
  type FieldsBlock,
  type RowAxis,
  type RowSelection,
} from '@latkit/model';
import {
  continues,
  monitorData,
  type MonitorData,
  type MonitorItem,
  type Reading,
  type Trace,
} from './data.js';
import type { Limits, MonitorStyle } from './options.js';
import {
  DEFAULTS,
  VIEW_DEFAULTS,
  resolveStyle,
  LIMITS,
  expanded,
  fail,
  type Style,
} from './config.js';
import { DEFAULT_CAMERA, checkCamera, mixCamera, move, type Camera } from './camera.js';
import { binding, describeBindings, validateData, type Binding } from './bindings.js';
import { axes, onPlot, plot, plotCoordinate, plotX, plotY, type Axes, type Plot } from './axes.js';
import { Fit, mergeDomain, tracePages } from './extents.js';
import { pipelines, type Pipelines } from './rendering/pipelines.js';
import {
  bindDraws,
  composite,
  destroyImage,
  enroll,
  image,
  imageBytes,
  paint,
  prepareScreen,
  sameTransform,
  traceDraws,
  type Draw,
  type Image,
  type Progress,
  type Screen,
  type Transform,
} from './rendering/painter.js';
import { pick } from './picking.js';

export interface MonitorConfig extends ItemViewConfig, MonitorStyle {
  /** Lines by name; several may read one type. */
  readonly traces: Readonly<Record<string, Trace>>;
  /** Where the camera starts; `monitor.camera` is where it is. y fits the data by default. */
  readonly camera: Partial<Camera> & { readonly x: Domain };
  readonly limits?: Limits;
}
export type MonitorEvents = ItemEvents<MonitorItem, Reading, Camera>;
export interface MonitorStats extends ViewStats {
  /** Rows the traces draw. */
  readonly rows: number;
  readonly historyBytes: number;
  /** Whether history is drawn. */
  readonly visible: boolean;
  /** Whether some frame in the window is not drawn yet. */
  readonly refining: boolean;
}
type Records = 'traces';
type Merged = 'camera' | 'input' | 'limits';
/**
 * Selects rows, each narrowed to one trace when it names a `trace`, and picks exact readings.
 * `at` draws the playhead.
 */
export interface Monitor extends ItemView<
  MonitorConfig,
  MonitorItem,
  Reading,
  Camera,
  MonitorEvents
> {
  set(patch: Patch<MonitorConfig, Records, Merged>, options?: SetOptions): void;
  /** The coordinate under a canvas point of the latest drawn plot; null off the plot or before a frame. */
  coordinateAt(point: Point): number | null;
  stats(): MonitorStats;
}

/** Draw sampled fields over a coordinate such as time, on a canvas or offscreen. */
export function createMonitor(gpu: Gpu, config: MonitorConfig): Monitor {
  return new MonitorView(gpu, config);
}
/** Style drawn into history pixels; the rest is composited, or changes no pixels at all. */
const HISTORY = new Set<keyof Style>(['msaa', 'traceColor', 'traceWidthPx']);
/** Style drawn into the focus image. */
const FOCUS = new Set<keyof Style>(['selectedColor', 'selectedWidthPx']);
/** A replacement for a new size waits until resizing pauses. */
const RESIZE_MS = 120;
/** What a config means to the monitor: its traces, limits, and style. */
interface Resolved {
  readonly config: MonitorConfig;
  readonly data: MonitorData;
  readonly limits: Required<Limits>;
  readonly style: Style;
}
/** The camera that shows readings: their coordinates and values, padded. */
function frameReadings(
  items: readonly MonitorItem[],
  camera: Camera,
  padding: number,
): Partial<Camera> {
  let lo = Infinity,
    hi = -Infinity,
    low = Infinity,
    high = -Infinity;
  for (const item of items) {
    const { coordinate, value } = item as Partial<Reading>;
    if (coordinate !== undefined && Number.isFinite(coordinate)) {
      lo = Math.min(lo, coordinate);
      hi = Math.max(hi, coordinate);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  const half = (camera.x[1] - camera.x[0]) / 2;
  return {
    ...(lo <= hi
      ? { x: hi > lo ? expanded([lo, hi], padding) : ([lo - half, lo + half] as Domain) }
      : {}),
    ...(low <= high ? { y: expanded([low, high], padding) } : {}),
  };
}
function includes(rows: RowAxis, row: number): boolean {
  return rows.kind === 'range'
    ? row >= rows.offset && row < rows.offset + rows.count
    : rows.values.includes(row);
}
/** The selected rows a trace draws, ascending; undefined when it draws none. */
function focused(selection: readonly MonitorItem[], trace: Binding): RowSelection | undefined {
  const index = trace.source.tables[trace.trace.from]?.index;
  // The index names the rows, so a selection survives appends that replace the Data value.
  const rows = index
    ? selection.filter(
        (item) => sameIndex(item.index, index) && (!item.trace || item.trace === trace.name),
      )
    : [];
  if (!index || !rows.length) return undefined;
  const values = Uint32Array.from(new Set(rows.map((item) => item.row))).sort();
  return values.length === 1
    ? { kind: 'range', index, offset: values[0], count: 1 }
    : { kind: 'indices', index, values };
}
/** Frames a trace draws for an image: the window plus one frame on each side, `[first, end)`. */
function span(trace: Binding, target: Image): readonly [number, number] | undefined {
  const pages = tracePages(trace);
  if (!pages) return undefined;
  const [first, end] = sampleFrames(pages, {
    kind: 'range',
    between: target.window,
    context: { before: 1, after: 1 },
  });
  return first < end ? [first, end] : undefined;
}
/** Whether an image holds every frame its window shows, once `advanced` lands. */
function complete(
  target: Image,
  traces: readonly Binding[],
  advanced: Prepared['advanced'] = [],
  rows?: (trace: Binding) => unknown,
) {
  return traces.every((trace) => {
    if (rows && !rows(trace)) return true;
    let progress = target.progress.get(trace.name);
    for (const item of advanced)
      if (item.target === target && item.trace === trace.name) progress = item.progress;
    const frames = span(trace, target);
    return !frames || (!progress?.chunk && (progress?.through ?? -Infinity) >= frames[1] - 1);
  });
}
/**
 * What one frame may draw: lines, and the blocks and bytes of observations it holds until the frame
 * is submitted. A frame group always finishes, so every frame makes progress.
 */
class Budget {
  constructor(
    private segments: number,
    private bytes: number,
    private blocks: number,
  ) {}
  spend(block: FieldsBlock, segments: number): void {
    this.segments -= segments;
    this.blocks--;
    this.bytes -=
      rowCount(block.rows) *
      block.samples!.coordinates.length *
      Object.keys(block.columns).length *
      8;
  }
  get spent(): boolean {
    return this.segments <= 0 || this.bytes <= 0 || this.blocks <= 0;
  }
}
/** History drawn for one output: the image shown, its replacement, and the selected rows. */
interface Surface {
  front?: Image;
  back?: Image;
  focus?: Image;
  /** The selection the focus image draws. */
  focusFor: readonly MonitorItem[];
  /** The plot size and when it last changed, to wait out a resize. */
  sized: { width: number; height: number; at: number };
  /** Whether its images hold every frame their windows show. */
  complete: boolean;
}
function surface(): Surface {
  return { focusFor: [], sized: { width: 0, height: 0, at: 0 }, complete: false };
}
function destroySurface(value: Surface): void {
  for (const image of new Set([value.front, value.back, value.focus])) destroyImage(image);
  value.front = value.back = value.focus = undefined;
}
/** What a prepared frame draws, and how far each image gets once it is submitted. */
interface Prepared {
  readonly surface: Surface;
  readonly pipeline: Pipelines;
  readonly screen: Screen;
  readonly paint: Map<Image, Draw[]>;
  readonly advanced: {
    readonly target: Image;
    readonly trace: string;
    readonly progress: Progress;
  }[];
  readonly shown: Shown;
}
/** The camera and plot of the latest submitted frame: what pick and locate read. */
interface Shown {
  readonly window: Domain;
  readonly values: Domain;
  readonly plot: Plot;
}

class MonitorView
  extends kit.BaseItemView<
    MonitorConfig,
    MonitorItem,
    Reading,
    Camera,
    MonitorEvents,
    Resolved,
    Prepared | undefined,
    Pipelines,
    Records,
    Merged
  >
  implements Monitor
{
  private traces?: Binding[];
  private setup?: Promise<void>;
  private setupStop?: AbortController;
  private error?: unknown;
  private extents = new Fit();
  /** Changes whenever history pixels must be drawn again; focus has its own. */
  private generation = 0;
  private focusGeneration = 0;
  /** The history the canvas shows. */
  private readonly presentedHistory = surface();
  /** The history exports draw, such as video, kept until the view presents again. */
  private exportedHistory?: Surface;
  /** The history of the latest prepared frame, which `pending` and `animating` follow. */
  private current = this.presentedHistory;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private layout?: Axes;
  private layoutKey = '';
  /** Axis labels by text: a tick that stays as the window moves keeps its glyphs. */
  private readonly labels = new kit.TextBank({ label: 'monitor axes' });
  private shown?: Shown;
  private inspection?: {
    readonly point: Point;
    readonly radius: number;
    readonly limit: number;
    readonly source: Data;
    readonly shown: Shown;
    readonly result: readonly Reading[];
  };
  private drawCalls = 0;
  /** The hover search: exact readings, a frame later. */
  private readonly nearest: kit.HoverSearch<Reading> = (point, radius, { signal }) =>
    this.shown ? this.read(point, radius, 1, signal).then((hits) => hits[0] ?? null) : null;
  constructor(gpu: Gpu, config: MonitorConfig) {
    super(gpu, config, {
      name: 'monitor',
      records: ['traces'],
      merged: ['camera', 'input', 'limits'],
      options: Object.keys(DEFAULTS),
      framed: ['y'],
      modes: ['inspect', 'navigate', 'none'],
      style: VIEW_DEFAULTS,
    });
    if (!config.camera?.x) fail('A monitor needs the coordinates its camera shows in x');
    this.start();
  }
  private get data(): MonitorData {
    return this.resolved.data;
  }
  private get style(): Style {
    return this.resolved.style;
  }
  private get limits(): Required<Limits> {
    return this.resolved.limits;
  }

  coordinateAt(point: Point): number | null {
    const shown = this.shown;
    return shown && onPlot(shown.plot, point)
      ? plotCoordinate(shown.plot, shown.window, point[0])
      : null;
  }
  stats(): MonitorStats {
    return {
      ...super.stats(),
      rows: this.traces?.reduce((n, trace) => n + trace.count, 0) ?? 0,
      historyBytes: this.historyBytes(),
      visible: !!this.presentedHistory.front,
      refining: !this.presentedHistory.complete,
      drawCalls: this.drawCalls,
    };
  }
  /** Readings frame once; no readings fit the values and show every recorded coordinate. */
  fit(items?: readonly MonitorItem[], options: SetOptions = {}): void {
    this.live();
    if (!items?.length) {
      const recorded = this.recorded();
      if (recorded) this.moveCamera({ x: recorded }, options);
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
  /** Readings frame their coordinates and values; otherwise the values fit the window's data. */
  private framing(
    items: readonly MonitorItem[] | undefined,
    camera: Camera,
  ): Partial<Camera> | undefined {
    if (items) return frameReadings(items, camera, this.style.domainPadding);
    const values = this.traces && this.extents.values(this.traces, camera.x);
    return values ? { y: expanded(values, this.style.domainPadding) } : undefined;
  }
  protected interpolate(from: Camera, to: Camera, t: number): Camera {
    return mixCamera(from, to, t);
  }
  protected panned(camera: Camera, dx: number, dy: number, viewport: Viewport): Camera {
    return move(camera, dx, dy, plot(viewport, this.style));
  }

  // ── Items ──
  /** A reading's point in the latest drawn frame; it lies off the plot outside the window. */
  protected position(item: MonitorItem): Point | null {
    const shown = this.shown,
      { coordinate, value } = item as Partial<Reading>;
    if (!shown || coordinate === undefined || value === undefined) return null;
    return [plotX(shown.plot, shown.window, coordinate), plotY(shown.plot, shown.values, value)];
  }
  protected identify(item: MonitorItem): string {
    return JSON.stringify([
      item.index.source,
      item.index.type,
      item.index.version,
      item.row,
      item.trace ?? null,
      (item as Partial<Reading>).frame ?? null,
    ]);
  }
  protected accept(item: MonitorItem): void {
    if (!Number.isSafeInteger(item.row) || item.row < 0) fail('Invalid selected row');
    if (!this.table(item)) throw failure('conflict', 'Selection belongs to another source');
  }
  /** Rows stay selected while a trace draws them and their row space stands, as through appends. */
  protected contains(item: MonitorItem): boolean {
    const rows = this.table(item)?.rows;
    if (!rows || !includes(rows, item.row)) return false;
    const traces = this.config.traces;
    return (item.trace === undefined ? Object.values(traces) : [traces[item.trace]]).some(
      (trace) =>
        trace?.from === item.index.type &&
        (!trace.rows || trace.rows.kind === 'ids' || includes(trace.rows, item.row)),
    );
  }
  /** The nearest `limit` readings. */
  protected hits(
    point: Point,
    radiusPx: number,
    options: { readonly limit: number; readonly signal?: AbortSignal },
  ): Promise<readonly Reading[]> {
    return this.read(point, radiusPx, options.limit, options.signal);
  }
  protected pipelines(format: GPUTextureFormat, msaa: 1 | 4, shade: Shade): Promise<Pipelines> {
    return pipelines(this.gpu, format, msaa, shade.wgsl);
  }
  /** A new shade's parameters draw into history, so history draws again. */
  protected shaded(): void {
    this.redraw();
  }

  // ── Config ──
  protected resolve(config: MonitorConfig): Resolved {
    const data = monitorData(config);
    validateData(data);
    return {
      config,
      data,
      limits: kit.resolveLimits(config.limits, LIMITS, 'monitor'),
      style: resolveStyle(config, this.sharedStyle(config)),
    };
  }
  protected configure(resolved: Resolved, before: Resolved): void {
    const { config: next, style: after } = resolved,
      { config: previous, style } = before;
    const appended =
      previous.source !== next.source &&
      previous.traces === next.traces &&
      !!this.traces &&
      continues(previous.source, next.source);
    if (appended) {
      // Drawn frames stand: the next frame draws only what arrived. Traces named by field follow
      // the source; explicit bindings keep theirs.
      this.traces = this.traces!.map((trace) =>
        typeof trace.trace.y === 'string' ? { ...trace, source: next.source } : trace,
      );
      // New observations change what lies under the pointer.
      this.refreshHover();
    } else if (previous.source !== next.source || previous.traces !== next.traces) {
      this.setupStop?.abort(new DOMException('Monitor traces superseded', 'AbortError'));
      this.setup = undefined;
      this.traces = undefined;
      this.error = undefined;
      this.extents = new Fit();
      this.redraw();
    }
    if (previous.traces !== next.traces) this.pruneSelection();
    if ([...HISTORY].some((key) => style[key] !== after[key])) this.redraw();
    if ([...FOCUS].some((key) => style[key] !== after[key])) this.focusGeneration++;
    this.invalidate();
  }
  /** History pixels no longer match: images draw again behind what is shown. */
  private redraw(): void {
    this.generation++;
    this.focusGeneration++;
  }

  // ── Frames ──
  protected get pending(): Promise<void> | undefined {
    if (this.closed || this.error) return undefined;
    if (this.setup) return this.setup;
    return this.current.complete ? undefined : Promise.resolve();
  }
  protected get animating(): boolean {
    return super.animating || (!this.closed && !this.current.complete);
  }
  protected async prepare(frame: kit.Preparation): Promise<Prepared | undefined> {
    this.live();
    frame.signal.throwIfAborted();
    if (this.error) throw this.error as Error;
    const work = new Work(frame.signal);
    // Compile while traces resolve.
    const compiling = this.framePipelines(frame);
    void compiling.catch(() => {});
    await this.initialize(work);
    const traces = this.traces;
    if (!traces) {
      this.invalidate();
      return undefined;
    }
    const camera = await this.frameCamera(frame, (items, current) => this.framing(items, current));
    // An animated shade bakes its parameters into history, which then draws every frame.
    if (this.shadeAnimating) this.redraw();
    const shading = this.shadeFrame(frame);
    const pipeline = await work.wait(compiling),
      area = plot(frame.viewport, this.style),
      wanted: Transform = {
        width: Math.max(1, Math.ceil(area.width * frame.viewport.pixelRatio)),
        height: Math.max(1, Math.ceil(area.height * frame.viewport.pixelRatio)),
        window: camera.x,
        values: camera.y,
        generation: this.generation,
      };
    // Exports draw their own history, so they never replace what the view presents.
    const history = frame.presented ? this.presentedHistory : (this.exportedHistory ??= surface());
    this.current = history;
    if (history.sized.width !== wanted.width || history.sized.height !== wanted.height)
      history.sized = { width: wanted.width, height: wanted.height, at: frame.timeMs };
    // A replacement draws behind the shown image; a new size waits until resizing pauses.
    if (sameTransform(history.front, wanted)) {
      destroyImage(history.back);
      history.back = undefined;
    } else if (!sameTransform(history.back, wanted) && this.resized(history, wanted, frame)) {
      destroyImage(history.back);
      history.back = undefined;
      history.back = this.makeImage(wanted);
    }
    const selection = this.selection;
    // The selection draws over the history being drawn, so it follows that image, not the request.
    const basis = history.back ?? history.front ?? wanted;
    const focusWanted: Transform = {
      width: basis.width,
      height: basis.height,
      window: basis.window,
      values: basis.values,
      generation: this.focusGeneration,
    };
    if (!selection.length) {
      destroyImage(history.focus);
      history.focus = undefined;
    } else if (selection !== history.focusFor || !sameTransform(history.focus, focusWanted)) {
      destroyImage(history.focus);
      history.focus = undefined;
      history.focus = this.makeImage(focusWanted);
    }
    history.focusFor = selection;
    const effect = this.gpu.device.createBindGroup({
      layout: pipeline.shade,
      entries: [{ binding: 0, resource: shading }],
    });
    // What has arrived reaches the shown image first, then the selection, then a replacement.
    const draws = new Map<Image, Draw[]>(),
      advanced: Prepared['advanced'] = [];
    const rows = (trace: Binding) => focused(selection, trace);
    const budget = new Budget(
      this.limits.segmentsPerFrame,
      this.gpu.budget.cpuBytes / 4,
      // Each block pins its reads, uploads, and pages until the frame is submitted.
      Math.max(1, Math.floor(this.gpu.budget.entries / 64)),
    );
    fill: for (const target of [
      history.front?.generation === this.generation ? history.front : undefined,
      history.focus,
      history.back,
    ])
      if (target)
        for (const trace of traces) {
          const only = target === history.focus ? rows(trace) : undefined;
          if (target === history.focus && !only) continue;
          await this.fill(frame, pipeline, target, trace, only, effect, budget, draws, advanced);
          if (budget.spent) break fill;
        }
    bindDraws(this.gpu, frame, pipeline, [...draws.values()].flat());
    frame.signal.throwIfAborted();
    // A replacement shows in the frame that completes it.
    const display =
      history.back && complete(history.back, traces, advanced)
        ? history.back
        : (history.front ?? history.back!);
    const key = JSON.stringify([frame.viewport, camera.x, camera.y, this.style]);
    if (!this.layout || key !== this.layoutKey) {
      this.layout = await axes(
        this.gpu,
        frame.viewport,
        camera.x,
        camera.y,
        this.style,
        frame.signal,
        this.labels,
      );
      this.layoutKey = key;
    }
    if (this.historyBytes() > this.limits.historyBytes)
      throw failure('resource-limit', 'Monitor history exceeds historyBytes');
    for (const value of [display, history.focus, ...draws.keys()]) if (value) enroll(frame, value);
    const screen = await prepareScreen(
      this.gpu,
      frame,
      pipeline,
      display,
      history.focus,
      camera.x,
      camera.y,
      this.layout,
      this.style,
      frame.at,
    );
    frame.signal.throwIfAborted();
    this.hoverFrame(frame, this.nearest);
    return {
      surface: history,
      pipeline,
      screen,
      paint: draws,
      advanced,
      shown: { window: camera.x, values: camera.y, plot: this.layout.plot },
    };
  }
  /**
   * Draw the frames of a trace an image is missing. Each read starts at the last frame drawn, so its
   * first line joins the one before, and draws only its first chunk; a chunk may stop between row
   * blocks and finish next frame.
   */
  private async fill(
    frame: kit.Preparation,
    pipeline: Pipelines,
    target: Image,
    trace: Binding,
    rows: RowSelection | undefined,
    effect: GPUBindGroup,
    budget: Budget,
    draws: Map<Image, Draw[]>,
    advanced: Prepared['advanced'],
  ): Promise<void> {
    const frames = span(trace, target);
    if (!frames) return;
    const [first, end] = frames,
      before = target.progress.get(trace.name) ?? {};
    let { through, chunk } = before;
    if (!chunk && through !== undefined && through >= end - 1) return;
    const area = plot(frame.viewport, this.style),
      out = draws.get(target) ?? [],
      // Only a focus image draws a selection of rows.
      focus = rows !== undefined;
    draws.set(target, out);
    const read = (offset: number, count: number) =>
      frame.reader.fields({
        source: this.data.source,
        from: trace.trace.from,
        rows: rows ?? trace.rows,
        fields: trace.fields,
        window: { kind: 'frames', offset, count },
      });
    let joined = through !== undefined;
    while (!budget.spent && (chunk || through === undefined || through < end - 1)) {
      const start =
          chunk?.start ?? (through === undefined ? first : joined ? through : through + 1),
        count = chunk?.frames ?? end - start;
      let length = 0,
        drawn = chunk?.rows ?? 0,
        whole = true;
      for await (const block of read(start, count)) {
        if (block.samples!.firstFrame !== start) break;
        length = block.samples!.coordinates.length;
        const after = block.rowOffset + rowCount(block.rows);
        if (after <= drawn) continue;
        if (budget.spent) {
          whole = false;
          break;
        }
        // A lone frame already drawn adds nothing; a frame after a gap draws as a dot.
        if (length > 1 || start !== through) {
          const result = traceDraws(
            this.gpu,
            frame,
            pipeline,
            block,
            trace,
            target,
            area,
            this.style,
            focus,
            effect,
            start !== through,
          );
          out.push(...result.draws);
          budget.spend(block, result.segments);
        }
        drawn = after;
      }
      if (!length) break;
      if (!whole) {
        chunk = { start, frames: length, rows: drawn };
        break;
      }
      chunk = undefined;
      if (length === 1 && start === through) {
        // A gap follows the last frame drawn: continue past it, unjoined.
        joined = false;
        continue;
      }
      through = start + length - 1;
      joined = true;
    }
    if (through !== before.through || chunk !== before.chunk)
      advanced.push({ target, trace: trace.name, progress: { through, chunk } });
  }
  protected encode(frame: kit.Encoding, prepared: Prepared | undefined): void {
    if (!prepared) return;
    let calls = 0;
    for (const [target, draws] of prepared.paint)
      calls += paint(frame, prepared.pipeline, target, draws);
    // A fresh image on screen with nothing drawn yet still clears.
    const { surface: history } = prepared;
    for (const target of [history.front ?? history.back, history.focus])
      if (target?.fresh && !prepared.paint.has(target)) paint(frame, prepared.pipeline, target, []);
    this.drawCalls = calls + composite(frame, prepared.pipeline, prepared.screen);
  }
  protected submitted(frame: FrameInfo, prepared: Prepared | undefined): void {
    if (!prepared) return;
    const { surface: history } = prepared;
    for (const target of [...prepared.paint.keys(), history.front ?? history.back, history.focus])
      if (target) target.fresh = false;
    for (const { target, trace, progress } of prepared.advanced)
      target.progress.set(trace, progress);
    const traces = this.traces ?? [];
    if (history.back && complete(history.back, traces)) {
      destroyImage(history.front);
      history.front = history.back;
      history.back = undefined;
    }
    if (!history.front && history.back) {
      // The first image shows as it draws.
      history.front = history.back;
      history.back = undefined;
    }
    history.complete =
      !history.back &&
      !!history.front &&
      history.front.generation === this.generation &&
      complete(history.front, traces) &&
      (!history.focus ||
        complete(history.focus, traces, [], (trace) => focused(history.focusFor, trace)));
    // An exported frame leaves what pick and locate read.
    if (!frame.presented) return;
    this.shown = prepared.shown;
    // Presenting again ends the exports, and the history they drew.
    if (this.exportedHistory) destroySurface(this.exportedHistory);
    this.exportedHistory = undefined;
  }
  protected release(): void {
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.inspection = undefined;
    destroySurface(this.presentedHistory);
    if (this.exportedHistory) destroySurface(this.exportedHistory);
    this.exportedHistory = undefined;
    this.shown = undefined;
    this.layout = undefined;
    this.labels.clear();
  }

  // ── History ──
  private async initialize(work: Work) {
    if (this.traces) return;
    if (!this.setup) {
      const control = new AbortController();
      this.setupStop = control;
      const signal = AbortSignal.any([this.signal, control.signal]),
        data = this.data;
      const task = (async () => {
        const reads = this.gpu.reader.open({ signal });
        try {
          const traces = await describeBindings(reads, data, this.camera.x);
          if (control.signal.aborted || this.closed) return;
          if (traces.reduce((n, trace) => n + trace.count, 0) > this.limits.rows)
            throw failure('resource-limit', 'Monitor row limit exceeded');
          this.traces = traces;
        } catch (error) {
          if (!control.signal.aborted) this.error = error;
        } finally {
          reads.close();
        }
      })();
      this.setup = task;
      void task.finally(() => {
        if (this.setup === task) this.setup = undefined;
      });
    }
    await work.wait(this.setup);
    if (this.error) throw this.error as Error;
  }
  /** Whether the plot size has held long enough to draw a replacement for it. */
  private resized(history: Surface, wanted: Transform, frame: kit.Preparation): boolean {
    const front = history.front;
    if (
      !front ||
      front.generation !== wanted.generation ||
      front.window[0] !== wanted.window[0] ||
      front.window[1] !== wanted.window[1] ||
      front.values[0] !== wanted.values[0] ||
      front.values[1] !== wanted.values[1]
    )
      return true;
    const waited = frame.timeMs - history.sized.at;
    if (waited >= RESIZE_MS) return true;
    if (this.resizeTimer === undefined)
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = undefined;
        this.invalidate();
      }, RESIZE_MS - waited);
    return false;
  }
  private makeImage(transform: Transform): Image {
    const bytes = imageBytes({
      width: transform.width,
      height: transform.height,
      msaa: this.style.msaa === 4 ? ({} as kit.TextureResource) : undefined,
    });
    if (this.historyBytes() + bytes > this.limits.historyBytes)
      throw failure(
        'resource-limit',
        'Monitor history exceeds historyBytes; reduce viewport or MSAA, or increase its limit',
      );
    return image(this.gpu, transform, this.style.msaa);
  }
  /** GPU memory the history images hold, the canvas's and any export's. */
  private historyBytes(): number {
    let bytes = 0;
    for (const history of [this.presentedHistory, this.exportedHistory])
      for (const value of [history?.front, history?.back, history?.focus])
        if (value) bytes += imageBytes(value);
    return bytes;
  }
  /** Every recorded coordinate of every trace. */
  private recorded(): Domain | null {
    let recorded: Domain | null = null;
    for (const trace of Object.values(this.data.traces)) {
      const main = binding(trace.y, this.data.source, trace.from);
      if (main)
        recorded = mergeDomain(
          recorded,
          sampleDomain(main.source.tables[main.from]?.fields[main.field]),
        );
    }
    return recorded;
  }

  // ── Inspection ──
  /** Exact readings near a point in the latest drawn frame, nearest first. */
  private async read(
    point: Point,
    radius: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly Reading[]> {
    this.live();
    const shown = this.shown,
      traces = this.traces;
    if (!shown || !traces) return [];
    const p = shown.plot;
    if (!onPlot(p, point)) return [];
    signal?.throwIfAborted();
    // The latest answer at this point stands while the data and what is shown stand.
    const cached = this.inspection,
      source = this.data.source;
    if (
      cached &&
      cached.point[0] === point[0] &&
      cached.point[1] === point[1] &&
      cached.radius === radius &&
      cached.limit >= limit &&
      cached.source === source &&
      cached.shown === shown
    )
      return cached.result.length > limit ? cached.result.slice(0, limit) : cached.result;
    const reads = this.gpu.reader.open({
      signal: signal ? AbortSignal.any([signal, this.signal]) : this.signal,
    });
    let result: Reading[];
    try {
      result = await pick({
        reads,
        data: this.data,
        bindings: traces,
        plot: p,
        x: shown.window,
        y: shown.values,
        point,
        radius,
        limit,
      });
    } finally {
      reads.close();
    }
    this.inspection = { point: [point[0], point[1]], radius, limit, source, shown, result };
    return result;
  }
  /** The table of an item's rows among the sources the traces read. */
  private table(item: MonitorItem): Data['tables'][string] | undefined {
    const config = this.config,
      sources = new Set([config.source]);
    for (const trace of Object.values(config.traces))
      if (typeof trace.y === 'object') sources.add(trace.y.source);
    for (const source of sources) {
      const table = source.tables[item.index?.type];
      if (table && sameIndex(table.index, item.index)) return table;
    }
    return undefined;
  }
}
