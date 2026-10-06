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
  insets,
  type Style,
} from './config.js';
import { DEFAULT_CAMERA, checkCamera, mixCamera, move, type Camera } from './camera.js';
import {
  binding,
  describeBindings,
  relook,
  sameReads,
  validateData,
  type Binding,
} from './bindings.js';
import { axes, onPlot, plot, plotCoordinate, plotX, plotY, type Axes, type Plot } from './axes.js';
import { Fit, mergeDomain, tracePages } from './extents.js';
import { pipelines, type Pipelines } from './rendering/pipelines.js';
import {
  bindDraws,
  composite,
  paint,
  prepareScreen,
  traceDraws,
  type Composited,
  type Draw,
  type Screen,
} from './rendering/painter.js';
import {
  destroyImage,
  enroll,
  image,
  imageBytes,
  plan,
  reconcile,
  sameTransform,
  type Group,
  type Image,
  type Layer,
  type Progress,
  type Transform,
} from './rendering/history.js';
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
  /** Line segments drawn into history so far; a new domain or colormap draws none. */
  readonly segments: number;
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
  area: Plot,
  [top, right, bottom, left]: readonly number[],
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
      ? {
          x:
            hi > lo
              ? expanded([lo, hi], left, right, area.width)
              : ([lo - half, lo + half] as Domain),
        }
      : {}),
    ...(low <= high ? { y: expanded([low, high], bottom, top, area.height) } : {}),
  };
}
const sameDomain = (a: Domain, b: Domain) => a[0] === b[0] && a[1] === b[1];
/**
 * The values a fit shows as data grows in one window: those shown while the data fits inside them,
 * else wider by half the data's span past each side it overflows.
 */
function grown(wanted: Domain, shown: Domain): Domain {
  if (wanted[0] >= shown[0] && wanted[1] <= shown[1]) return shown;
  const half = (wanted[1] - wanted[0]) / 2;
  return [
    wanted[0] < shown[0] ? wanted[0] - half : shown[0],
    wanted[1] > shown[1] ? wanted[1] + half : shown[1],
  ];
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
/** An image's groups, and the layer each has in it. */
interface Planned {
  readonly groups: readonly Group[];
  readonly layers: readonly (Layer | undefined)[];
}
/** Whether an image's layers hold every frame its window shows of their traces, once `advanced` lands. */
function complete(target: Image, planned: Planned, advanced: Prepared['advanced'] = []): boolean {
  return planned.groups.every((group, i) => {
    const layer = planned.layers[i];
    return (
      !!layer &&
      group.traces.every((trace) => {
        const frames = span(trace, target);
        if (!frames) return true;
        let progress = layer.progress.get(trace.name);
        for (const item of advanced)
          if (item.layer === layer && item.trace === trace.name) progress = item.progress;
        return !progress?.chunk && (progress?.through ?? -Infinity) >= frames[1] - 1;
      })
    );
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
/** What a prepared frame draws, and how far each layer gets once it is submitted. */
interface Prepared {
  readonly surface: Surface;
  readonly pipeline: Pipelines;
  readonly screen: Screen;
  /** Each image's groups, and their layers. */
  readonly plans: ReadonlyMap<Image, Planned>;
  readonly paint: Map<Layer, Draw[]>;
  /** The layers the screen shows; a fresh one still clears. */
  readonly composed: readonly Layer[];
  readonly advanced: {
    readonly layer: Layer;
    readonly trace: string;
    readonly progress: Progress;
  }[];
  /** Line segments its draws add to history. */
  readonly segments: number;
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
  /** Traces whose config changed since they were described: to read again, or only to look again. */
  private readonly stale = new Map<string, 'read' | 'look'>();
  private setup?: Promise<void>;
  private setupStop?: AbortController;
  private error?: unknown;
  private extents = new Fit();
  /** Counts shades: color layers bake theirs, so a new or animated one draws them again. */
  private shading = 0;
  /** Line segments drawn into history, all time. */
  private segments = 0;
  /** The window and values the latest fit framed: while both stand, arriving data grows the values. */
  private fitted?: { readonly x: Domain; readonly y: Domain };
  /** The latest groups of history images, and of the selection's, and what they were planned for. */
  private readonly planned = new Map<
    boolean,
    { readonly key: readonly unknown[]; readonly groups: readonly Group[] }
  >();
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
      segments: this.segments,
      drawCalls: this.drawCalls,
    };
  }
  /** Readings frame once; no readings fit the values and show every recorded coordinate. */
  fit(items?: readonly MonitorItem[], options: SetOptions = {}): void {
    this.live();
    // Asked for, a fit is tight.
    this.fitted = undefined;
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
  /**
   * Readings frame their coordinates and values; otherwise the values fit the window's data. Either
   * leaves `fitPaddingPx` clear around what it frames, as every view's fit does.
   */
  private framing(
    items: readonly MonitorItem[] | undefined,
    camera: Camera,
    viewport: Viewport,
  ): Partial<Camera> | undefined {
    const area = plot(viewport, this.style),
      padding = insets(this.style.fitPaddingPx);
    if (items) return frameReadings(items, camera, area, padding);
    const values = this.traces && this.extents.values(this.traces, camera.x);
    if (!values) return undefined;
    // A window fits tightly; data arriving in it grows the values with headroom, so a run of new
    // extremes draws history again a few times, not at each.
    const tight = expanded(values, padding[2], padding[0], area.height),
      held = this.fitted,
      y =
        held && sameDomain(held.x, camera.x) && sameDomain(held.y, camera.y)
          ? grown(tight, camera.y)
          : tight;
    this.fitted = { x: camera.x, y };
    return { y };
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
    return (this.traces ?? []).some(
      (trace) =>
        (item.trace === undefined || trace.name === item.trace) &&
        trace.trace.from === item.index.type &&
        (!trace.rows || includes(trace.rows, item.row)),
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
  /** A new shade bakes into color layers; value layers shade as they compose. */
  protected shaded(): void {
    this.shading++;
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
    const { config: next } = resolved,
      { config: previous } = before;
    if (previous.source !== next.source) {
      if (continues(previous.source, next.source)) {
        // Drawn frames stand, whatever else changed with them: the next frame draws only what
        // arrived. Traces named by field follow the source; explicit bindings keep theirs.
        if (this.traces)
          this.traces = this.traces.map((trace) =>
            typeof trace.trace.y === 'string' ? { ...trace, source: next.source } : trace,
          );
        // New observations change what lies under the pointer.
        this.refreshHover();
      } else this.restart();
    }
    if (previous.traces !== next.traces) {
      this.retrace(previous.traces, next.traces);
      this.pruneSelection();
    }
    this.invalidate();
  }
  /** Other data: every trace is described again, as versions no layer holds. */
  private restart(): void {
    this.setupStop?.abort(new DOMException('Monitor traces superseded', 'AbortError'));
    this.setup = undefined;
    this.traces = undefined;
    this.stale.clear();
    this.error = undefined;
    this.extents = new Fit();
    this.fitted = undefined;
  }
  /** A changed trace looks again when it reads the same, and is described again otherwise. */
  private retrace(before: MonitorData['traces'], after: MonitorData['traces']): void {
    for (const [name, trace] of Object.entries(after)) {
      const was = before[name];
      if (was === trace) continue;
      this.stale.set(
        name,
        was && this.stale.get(name) !== 'read' && sameReads(was, trace) ? 'look' : 'read',
      );
    }
    for (const name of [...this.stale.keys()]) if (!(name in after)) this.stale.delete(name);
    // Other reads frame other values: the next fit is tight.
    if ([...this.stale.values()].includes('read') || Object.keys(before).some((n) => !(n in after)))
      this.fitted = undefined;
    if (this.traces) {
      const named = new Map(this.traces.map((trace) => [trace.name, trace]));
      this.traces = Object.keys(after).flatMap((name) => named.get(name) ?? []);
    }
    // What is underway described the old traces.
    this.setupStop?.abort(new DOMException('Monitor traces superseded', 'AbortError'));
    this.setup = undefined;
    this.error = undefined;
  }
  /** The groups of history images, or of the selection's, kept while their traces and style stand. */
  private planOf(
    traces: readonly Binding[],
    focus: boolean,
    selection: readonly MonitorItem[],
    selected: ReadonlyMap<string, RowSelection | undefined>,
  ): readonly Group[] {
    const drawn = this.drawnWith(focus),
      baked = this.bakedWith(focus),
      key = [traces, focus ? selection : undefined, JSON.stringify([drawn, baked])],
      held = this.planned.get(focus);
    if (held && held.key.every((value, i) => value === key[i])) return held.groups;
    const groups = plan(
      focus ? traces.filter((trace) => selected.get(trace.name)) : traces,
      drawn,
      baked,
    );
    this.planned.set(focus, { key, groups });
    return groups;
  }
  /** What every layer of an image draws lines with: their width, and a selection's. */
  private drawnWith(focus: boolean): unknown {
    return focus ? [this.style.traceWidthPx, this.style.selectedWidthPx] : this.style.traceWidthPx;
  }
  /** What a color layer bakes beyond its traces' colors: the default color, a selection's, and the shade. */
  private bakedWith(focus: boolean): unknown {
    return [this.style.traceColor, focus ? this.style.selectedColor : null, this.shading];
  }
  /** Admit `bytes` more history, or fail as history past its limit does. */
  private reserve(bytes: number): void {
    if (this.historyBytes() + bytes > this.limits.historyBytes)
      throw failure(
        'resource-limit',
        'Monitor history exceeds historyBytes; reduce viewport or MSAA, or increase its limit',
      );
  }

  // ── Frames ──
  protected get pending(): Promise<void> | undefined {
    if (this.closed || this.error) return undefined;
    if (this.setup) return this.setup;
    return this.current.complete && !this.stale.size ? undefined : Promise.resolve();
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
    const camera = await this.frameCamera(frame, (items, current, viewport) =>
      this.framing(items, current, viewport),
    );
    // Color layers bake the shade, so an animated one draws them each frame; value layers shade as
    // they compose.
    if (this.shadeAnimating) this.shading++;
    const shading = this.shadeFrame(frame);
    const pipeline = await work.wait(compiling),
      area = plot(frame.viewport, this.style),
      wanted: Transform = {
        width: Math.max(1, Math.ceil(area.width * frame.viewport.pixelRatio)),
        height: Math.max(1, Math.ceil(area.height * frame.viewport.pixelRatio)),
        window: camera.x,
        values: camera.y,
        msaa: this.style.msaa,
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
      history.back = image(wanted);
    }
    const selection = this.selection;
    // The selection draws over the history being drawn, so it follows that image, not the request.
    const basis = history.back ?? history.front ?? wanted;
    if (!selection.length) {
      destroyImage(history.focus);
      history.focus = undefined;
    } else if (selection !== history.focusFor || !sameTransform(history.focus, basis)) {
      destroyImage(history.focus);
      history.focus = image(basis);
    }
    history.focusFor = selection;
    const effect = this.gpu.device.createBindGroup({
      layout: pipeline.shade,
      entries: [{ binding: 0, resource: shading }],
    });
    // Each image's layers follow its groups: traces that look alike share one. A shown image whose
    // replacement draws behind it starts nothing over, as the replacement draws it all.
    const selected = new Map(
        traces.map((trace) => [trace.name, focused(selection, trace)] as const),
      ),
      images = [
        [history.front, false],
        [history.focus, true],
        [history.back, false],
      ] as const,
      plans = new Map<Image, Planned>();
    for (const [target, focus] of images) {
      if (!target) continue;
      const groups = this.planOf(traces, focus, selection, selected);
      plans.set(target, {
        groups,
        layers: reconcile(
          this.gpu,
          target,
          groups,
          (bytes) => this.reserve(bytes),
          target !== history.front || !history.back,
        ),
      });
    }
    // What has arrived reaches the shown image first, then the selection, then a replacement.
    const draws = new Map<Layer, Draw[]>(),
      advanced: Prepared['advanced'] = [];
    const budget = new Budget(
      this.limits.segmentsPerFrame,
      this.gpu.budget.cpuBytes / 4,
      // Each block pins its reads, uploads, and pages until the frame is submitted.
      Math.max(1, Math.floor(this.gpu.budget.entries / 64)),
    );
    let segments = 0;
    fill: for (const [target, focus] of images) {
      const planned = target && plans.get(target);
      if (planned)
        for (const [i, group] of planned.groups.entries()) {
          const layer = planned.layers[i];
          if (layer)
            for (const trace of group.traces) {
              segments += await this.fill(
                frame,
                target,
                layer,
                trace,
                focus ? selected.get(trace.name) : undefined,
                effect,
                budget,
                draws,
                advanced,
              );
              if (budget.spent) break fill;
            }
        }
    }
    bindDraws(this.gpu, frame, pipeline, [...draws.values()].flat());
    frame.signal.throwIfAborted();
    // A replacement shows in the frame that completes it.
    const display =
      history.back && complete(history.back, plans.get(history.back)!, advanced)
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
    // The selection fades the rest, and draws over it.
    const fade = history.focus ? this.style.unselectedAlpha : 1,
      layers: Composited[] = [];
    for (const [target, focus] of [
      [display, false],
      [history.focus, true],
    ] as const)
      for (const layer of target?.layers ?? [])
        layers.push({
          image: target!,
          layer,
          look: layer.look,
          focus,
          alpha: focus ? 1 : fade,
        });
    const composed = layers.map((entry) => entry.layer);
    for (const layer of new Set([...composed, ...draws.keys()])) enroll(frame, layer);
    const screen = await prepareScreen(
      this.gpu,
      frame,
      pipeline,
      layers,
      camera.x,
      camera.y,
      this.layout,
      this.style,
      frame.at,
      effect,
    );
    frame.signal.throwIfAborted();
    this.hoverFrame(frame, this.nearest);
    return {
      surface: history,
      pipeline,
      screen,
      plans,
      paint: draws,
      composed,
      advanced,
      segments,
      shown: { window: camera.x, values: camera.y, plot: this.layout.plot },
    };
  }
  /**
   * Draw the frames of a trace its layer is missing; returns the segments drawn. Each read starts at
   * the last frame drawn, so its first line joins the one before, and draws only its first chunk; a
   * chunk may stop between row blocks and finish next frame.
   */
  private async fill(
    frame: kit.Preparation,
    target: Image,
    layer: Layer,
    trace: Binding,
    rows: RowSelection | undefined,
    effect: GPUBindGroup,
    budget: Budget,
    draws: Map<Layer, Draw[]>,
    advanced: Prepared['advanced'],
  ): Promise<number> {
    const frames = span(trace, target);
    if (!frames) return 0;
    const [first, end] = frames,
      before = layer.progress.get(trace.name) ?? {};
    let { through, chunk } = before;
    if (!chunk && through !== undefined && through >= end - 1) return 0;
    const area = plot(frame.viewport, this.style),
      out = draws.get(layer) ?? [],
      // Only a focus layer draws a selection of rows.
      focus = rows !== undefined;
    draws.set(layer, out);
    const read = (offset: number, count: number) =>
      frame.reader.fields({
        source: this.data.source,
        from: trace.trace.from,
        rows: rows ?? trace.rows,
        fields: trace.fields,
        window: { kind: 'frames', offset, count },
      });
    let joined = through !== undefined,
      segments = 0;
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
            frame,
            block,
            trace,
            target,
            layer,
            area,
            this.style,
            focus,
            effect,
            start !== through,
          );
          out.push(...result.draws);
          budget.spend(block, result.segments);
          segments += result.segments;
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
      advanced.push({ layer, trace: trace.name, progress: { through, chunk } });
    return segments;
  }
  protected encode(frame: kit.Encoding, prepared: Prepared | undefined): void {
    if (!prepared) return;
    let calls = 0;
    for (const [layer, draws] of prepared.paint)
      if (draws.length || layer.fresh) calls += paint(frame, prepared.pipeline, layer, draws);
    // A fresh layer on screen with nothing drawn yet still clears.
    for (const layer of prepared.composed)
      if (layer.fresh && !prepared.paint.has(layer)) paint(frame, prepared.pipeline, layer, []);
    this.drawCalls = calls + composite(frame, prepared.pipeline, prepared.screen);
  }
  protected submitted(frame: FrameInfo, prepared: Prepared | undefined): void {
    if (!prepared) return;
    const { surface: history, plans } = prepared;
    for (const layer of [...prepared.paint.keys(), ...prepared.composed]) layer.fresh = false;
    for (const { layer, trace, progress } of prepared.advanced) layer.progress.set(trace, progress);
    this.segments += prepared.segments;
    const done = (target: Image | undefined) => {
      const planned = target && plans.get(target);
      return !!planned && complete(target, planned);
    };
    if (history.back && done(history.back)) {
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
      !history.back && done(history.front) && (!history.focus || done(history.focus));
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
  /**
   * Describe what is new: every trace at first and after other data, then only traces that read
   * differently. A trace whose look alone changed keeps what it reads and resolves its look again.
   */
  private async initialize(work: Work) {
    if (this.traces && !this.stale.size) return;
    if (!this.setup) {
      const control = new AbortController();
      this.setupStop = control;
      const signal = AbortSignal.any([this.signal, control.signal]),
        data = this.data,
        window = this.camera.x,
        whole = !this.traces,
        kept = new Map((this.traces ?? []).map((trace) => [trace.name, trace])),
        stale = new Map(this.stale);
      const task = (async () => {
        const reads = this.gpu.reader.open({ signal });
        try {
          const names = Object.keys(data.traces),
            described = await describeBindings(
              reads,
              data,
              window,
              names.filter((name) => whole || stale.get(name) === 'read' || !kept.has(name)),
            ),
            fresh = new Map(described.map((trace) => [trace.name, trace]));
          for (const [name, kind] of stale)
            if (kind === 'look' && kept.has(name) && !fresh.has(name))
              fresh.set(
                name,
                await relook(reads, data, kept.get(name)!, data.traces[name], window),
              );
          if (control.signal.aborted || this.closed) return;
          // Frames appended meanwhile belong to traces named by field, as an append's do.
          const source = this.data.source,
            traces = names.map((name) => {
              const trace = fresh.get(name) ?? kept.get(name)!;
              return typeof trace.trace.y === 'string' && trace.source !== source
                ? { ...trace, source }
                : trace;
            });
          if (traces.reduce((n, trace) => n + trace.count, 0) > this.limits.rows)
            throw failure('resource-limit', 'Monitor row limit exceeded');
          this.traces = traces;
          this.stale.clear();
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
      front.msaa !== wanted.msaa ||
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
  /** GPU memory the history layers hold, the canvas's and any export's. */
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
