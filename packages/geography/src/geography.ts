import {
  kit,
  type Gpu,
  type ItemView,
  type Point,
  type ProjectedCamera,
  type Shade,
  type FrameInfo,
  type Viewport,
  type View,
  type Channel,
  type RGBA,
  type Labels,
} from '@latkit/gpu';
import { failure, itemKey, type Data, type FieldInput, type Item } from '@latkit/model';
import {
  AREA,
  DEFAULTS,
  LINE,
  VIEW_DEFAULTS,
  checkRecord,
  isData,
  lightOf,
  resolveStyle,
  shapeField,
  strokesRings,
  type Style,
} from './options.js';
import { pick, positionIn, type Drawn } from './picking.js';
import { isTiles, type TileSet, type Tiles } from './tiles.js';
import { Labels as SceneLabels, type LabelSource } from './scene/labels.js';
import { RecordStyles } from './scene/records.js';
import { Sources, type Prepared, type VectorTileData } from './scene/sources.js';
import type { Placed } from './scene/pyramid.js';
import {
  levelFor,
  pixelsPerDegree,
  visibleRanges,
  visibleRegion,
  type Region,
} from './scene/visible.js';
import type { VectorLayerRequest } from './sources/vector.js';
import { Painter, type Paint, type ShapeDraw } from './rendering/painter.js';
import { pipelines, type Pipelines } from './rendering/pipelines.js';
import { warm } from './prepare/client.js';

/** A row of the model, which each of the view's items is; named apart from the view's own Item. */
type ModelItem = Item;
const { Projector } = kit;
const NONE = 0xffffffff;

const DEFAULT_LIMITS: Required<Geography.Limits> = Object.freeze({
  tileBytes: 64 * 1024 ** 2,
  tileRequests: 8,
});
type Records = 'areas' | 'lines';
type Merged = 'camera' | 'input' | 'limits';
export interface Geography extends ItemView<
  Geography.Config,
  Geography.Item,
  Geography.Item,
  ProjectedCamera,
  Geography.Events
> {
  set(patch: View.Patch<Geography.Config, Records, Merged>, options?: View.SetOptions): void;
  stats(): Geography.Stats;
}
export declare namespace Geography {
  interface Config extends ItemView.Config, Style {
    /**
     * Where areas and lines read their shapes and fields: Data, or tiles. A record may name its own.
     * Borrowed: destroy never closes it.
     */
    readonly source?: Data | Tiles;
    /** Filled regions by type, drawn in order over the ground. */
    readonly areas?: Readonly<Record<string, AreaOptions>>;
    /** Polylines by type, drawn in order over areas: coasts, borders, rivers, an area type's outline. */
    readonly lines?: Readonly<Record<string, LineOptions>>;
    /** Where the camera starts; `geography.camera` is where it is. Fits the shapes by default. */
    readonly camera?: Partial<ProjectedCamera>;
    readonly limits?: Limits;
  }
  type Events = ItemView.Events<Item, Item, ProjectedCamera>;
  interface Stats extends View.Stats {
    /** Tiles loaded, and still loading. */
    readonly tiles: number;
    readonly loading: number;
    /** Vertices the latest frame drew, three a triangle and two a line point, and its triangles. */
    readonly vertices: number;
    readonly triangles: number;
    /** GPU bytes the shapes and tiles hold. */
    readonly geometryBytes: number;
  }
  interface Limits {
    /** GPU bytes loaded tiles may hold, each source, before the least recently drawn go. */
    readonly tileBytes?: number;
    /** Tile requests in flight at once, each source. */
    readonly tileRequests?: number;
  }
  /** An item a geography draws: a row of an area or line type. */
  interface Item extends ModelItem {
    readonly kind: 'area' | 'line';
  }
  /** How the earth draws, beyond the shared view style; every option has a default. */
  interface Style extends kit.LineStyle, kit.ProjectedStyle {
    /** The ground beneath everything. */
    readonly surfaceColor?: RGBA;
    /** Lines of longitude and latitude, spaced for the zoom. */
    readonly graticule?: boolean;
    readonly graticuleColor?: RGBA;
    /** How close the graticule's lines may draw, in CSS pixels; it picks the nicest spacing at least this. */
    readonly graticuleSpacingPx?: number;
    /** Light by the sun at a time in milliseconds, at the current time, or not at all; a hosting network is lit too. */
    readonly daylight?: number | 'now' | false;
    /** How bright night stays, from 0 to 1, for the ground and everything on it. */
    readonly nightFloor?: number;
    /** How wide the band from day to night is. */
    readonly terminatorWidth?: number;
    /** A glow around the globe's rim. */
    readonly atmosphere?: boolean;
    readonly atmosphereColor?: RGBA;
    /** The axis the globe turns on, through its poles. */
    readonly earthAxis?: boolean;
    readonly earthAxisColor?: RGBA;
    /** The color of areas their `color` leaves unset. */
    readonly areaColor?: RGBA;
    /** The color of lines their `color` leaves unset. */
    readonly lineColor?: RGBA;
    /** The width of lines their `widthPx` leaves unset. */
    readonly lineWidthPx?: number;
  }
  /** What areas and lines share: where their shapes and values come from, and their channels. */
  interface ShapeOptions {
    /** Where the shapes come from: Data, or tiles; the config's `source` by default. */
    readonly source?: Data | Tiles;
    /**
     * Rows of the same type, matched to the shapes' rows by id, that the channels read: a run's
     * results coloring a static map. The shapes' own rows by default.
     */
    readonly values?: Data;
    /** `areaColor` or `lineColor` by default. */
    readonly color?: Channel.Color;
    readonly visible?: Channel<boolean>;
    /** The value the view's `shade` reads. */
    readonly shade?: Channel;
    /** Text at each row's anchor: an area's widest point, a line's middle. */
    readonly labels?: string | Labels | null;
  }
  interface AreaOptions extends ShapeOptions {
    /** Rings of longitude and latitude; a hole winds opposite its outline. `rings` by default. */
    readonly rings?: FieldInput;
  }
  interface LineOptions extends ShapeOptions {
    /** Points, or lists of them; an area type's `rings` draw its outline. `points` by default. */
    readonly points?: FieldInput;
    /**
     * How a line between geographic points runs over the earth: `straight` in longitude and
     * latitude, or `geodesic` along the great circle. `straight` by default, as maps record their
     * features: a border along a parallel stays on it.
     */
    readonly route?: 'straight' | 'geodesic';
    /** `lineWidthPx` by default. */
    readonly widthPx?: Channel;
    readonly dash?: Channel<boolean>;
    /**
     * How far comets move along the line each second, in CSS pixels, from its first point toward its
     * last; negative runs the other way, and 0 draws none. A field spans 0 to 40.
     */
    readonly flowPx?: Channel;
  }
  interface GeoJsonOptions {
    /** The type features become: one name for all, or a name per feature from its properties. 'Feature' by default. */
    readonly type?: string | ((properties: Readonly<Record<string, unknown>>) => string);
    /** A property holding each feature's id; the feature's own `id`, else its type and place, by default. */
    readonly id?: string;
    /** The Index source name rows are numbered under; a fresh one by default. */
    readonly source?: string;
    /** Stops reading and parsing; the promise rejects. */
    readonly signal?: AbortSignal;
  }
}

/** Draw the earth and what lies on it: on a canvas, offscreen, or beneath a network. */
export function createGeography(gpu: Gpu, config: Geography.Config = {}): Geography {
  return new GeographyView(gpu, config);
}

interface Resolved {
  readonly config: Geography.Config;
  readonly style: Style;
  readonly limits: Required<Geography.Limits>;
  /** Whether any line type moves comets along itself. */
  readonly flowing: boolean;
}
/** A record this frame resolved: what it draws from, before its look. */
interface Planned {
  readonly kind: 'area' | 'line';
  readonly type: string;
  readonly options: Geography.AreaOptions | Geography.LineOptions;
  readonly data: Data;
  readonly prepared: Prepared;
  /** A tile's shapes draw whole; Data's by what is in view. */
  readonly whole: boolean;
}
interface Frame {
  readonly paint: Paint;
  readonly projector: kit.Projector;
  readonly drawn: readonly Drawn[];
  readonly commits: readonly (() => void)[];
  readonly live: Parameters<Sources['keep']>[0];
  readonly counts: {
    readonly vertices: number;
    readonly triangles: number;
    readonly drawCalls: number;
  };
}

/** Shapes prepare in workers: they start as a config names any, so its first frame finds them running. */
function warmFor(config: Geography.Config): void {
  if (Object.keys(config.areas ?? {}).length || Object.keys(config.lines ?? {}).length) warm();
}
class GeographyView
  extends kit.ProjectedView<
    Geography.Config,
    Geography.Item,
    Geography.Item,
    Geography.Events,
    Resolved,
    Frame,
    Pipelines,
    Records,
    Merged
  >
  implements Geography
{
  private readonly records: RecordStyles;
  private readonly painter: Painter;
  private readonly sources: Sources;
  private readonly labels = new SceneLabels();
  /** The latest drawn frame: what pick, locate, and selection see. */
  private shown?: Frame;
  /** The selection's rows in each drawn Data, a bit per row, made as frames first draw them. */
  private selectionBits?: {
    readonly selection: readonly Geography.Item[];
    readonly bits: WeakMap<Data, Map<string, kit.BufferData | null>>;
  };
  private counts = { vertices: 0, triangles: 0, drawCalls: 0 };
  /** When comets began to move, in the frames' clock. */
  private clock?: number;
  constructor(gpu: Gpu, config: Geography.Config) {
    super(gpu, config, {
      name: 'geography',
      records: ['areas', 'lines'],
      merged: ['camera', 'input', 'limits'],
      options: [...Object.keys(DEFAULTS), 'limits'],
      style: VIEW_DEFAULTS,
    });
    this.records = new RecordStyles(gpu);
    this.painter = new Painter(gpu, this.records);
    this.sources = new Sources(gpu, {
      invalidate: () => {
        if (!this.closed) {
          this.refreshHover();
          this.invalidate();
        }
      },
      fail: (error) => {
        if (!this.closed) this.fail(error);
      },
      signal: this.signal,
      limits: () => this.resolved.limits,
    });
    this.start();
    warmFor(config);
  }
  protected get style(): Style {
    return this.resolved.style;
  }
  stats(): Geography.Stats {
    const tiles = this.sources.tiles;
    return {
      ...super.stats(),
      ...this.counts,
      tiles: tiles.held,
      loading: tiles.loading,
      geometryBytes: this.sources.bytes,
    };
  }

  protected checkSource(source: unknown): void {
    if (source != null && !isData(source) && !isTiles(source))
      throw failure('invalid-input', 'A geography source is Data or tiles');
  }
  protected defaultCamera(): ProjectedCamera {
    return { ...Projector.camera, projection: 'mercator' };
  }
  /** Where the drawn records hold an item: each record, and the item's place in its rows. */
  private placements(item: Geography.Item): { readonly record: Drawn; readonly at: number }[] {
    const out: { record: Drawn; at: number }[] = [];
    for (const record of this.shown?.drawn ?? [])
      if (record.kind === item.kind && record.type === item.index.type) {
        const at = positionIn(record.source, record.type, item);
        if (at >= 0 && at < record.shapes.rows) out.push({ record, at });
      }
    return out;
  }
  protected position(item: Geography.Item): Point | null {
    const shown = this.shown;
    for (const { record, at } of this.placements(item)) {
      const x = record.shapes.anchors[at * 2],
        y = record.shapes.anchors[at * 2 + 1];
      if (!Number.isFinite(x) || !shown) continue;
      const p = shown.projector.project(x, y);
      if (p.visible) return [p.x, p.y];
    }
    return null;
  }
  protected identify(item: Geography.Item): string {
    return itemKey(item, item.kind);
  }
  protected contains(item: Geography.Item): boolean {
    return this.placements(item).length > 0;
  }
  protected hits(
    point: Point,
    radiusPx: number,
    options: { readonly limit: number },
  ): readonly Geography.Item[] {
    const shown = this.shown;
    return shown ? pick(shown.drawn, shown.projector, point, radiusPx, options.limit) : [];
  }
  protected pipelines(format: GPUTextureFormat, msaa: 1 | 4, shade: Shade): Promise<Pipelines> {
    return pipelines(this.gpu, format, msaa, shade.wgsl);
  }

  protected resolve(config: Geography.Config): Resolved {
    for (const [type, options] of Object.entries(config.areas ?? {}))
      checkRecord('area', type, options, isTiles);
    for (const [type, options] of Object.entries(config.lines ?? {}))
      checkRecord('line', type, options, isTiles);
    return {
      config,
      style: resolveStyle(config, this.sharedStyle(config)),
      limits: kit.resolveLimits(config.limits, DEFAULT_LIMITS, 'geography'),
      flowing: Object.values(config.lines ?? {}).some(
        (line) => line.flowPx != null && line.flowPx !== 0,
      ),
    };
  }
  protected configure(next: Resolved, previous: Resolved): void {
    if (
      next.config.source !== previous.config.source ||
      next.config.areas !== previous.config.areas ||
      next.config.lines !== previous.config.lines
    )
      this.pruneSelection();
    warmFor(next.config);
    this.invalidate();
  }
  protected get pending(): Promise<void> | undefined {
    return this.sources.pending;
  }
  /** Comets move, unless motion is reduced. */
  protected get animating(): boolean {
    return super.animating || (this.moving && this.style.flowSpacingPx > 0);
  }
  private get moving(): boolean {
    return this.resolved.flowing && !this.reducedMotion;
  }
  protected layerLook(): kit.LayerLook {
    return { light: lightOf(this.style), fill: this.style.surfaceColor };
  }

  /** How the shapes, or some items, frame: all of what has loaded, or the items' rows. */
  private framing(
    items: readonly Geography.Item[] | undefined,
    camera: ProjectedCamera,
    viewport: Viewport,
  ): Partial<ProjectedCamera> | undefined {
    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    const add = (box: ArrayLike<number>, at = 0) => {
      if (!(box[at] <= box[at + 2])) return;
      w = Math.min(w, box[at]);
      s = Math.min(s, box[at + 1]);
      e = Math.max(e, box[at + 2]);
      n = Math.max(n, box[at + 3]);
    };
    if (items) {
      // A feature split across tiles frames whole.
      for (const item of items)
        for (const { record, at } of this.placements(item)) add(record.shapes.bounds, at * 4);
    } else {
      for (const record of this.shown?.drawn ?? []) add(record.shapes.extent);
      const { config } = this.resolved;
      for (const tiles of this.tileSets(config)) {
        const source = this.sources.opened(tiles);
        if (source) add(source.bounds);
      }
    }
    return w <= e ? this.fitted(camera, [w, s, e, n], viewport) : undefined;
  }
  private tileSets(config: Geography.Config): TileSet[] {
    const out = new Set<TileSet>();
    const add = (source: unknown) => {
      if (isTiles(source)) out.add(source);
    };
    add(config.source);
    for (const options of [
      ...Object.values(config.areas ?? {}),
      ...Object.values(config.lines ?? {}),
    ])
      add(options.source);
    return [...out];
  }

  protected async prepare(frame: kit.Preparation): Promise<Frame> {
    this.live();
    const camera = await this.frameCamera(frame, (items, current, viewport) =>
      this.framing(items, current, viewport),
    );
    return this.render(frame, this.orbited(frame, camera), this.style.msaa);
  }
  /** A frame drawn beneath a host: its camera, its samples, and its scene block, bound as this frame's own. */
  protected async prepareLayer(frame: kit.Preparation, scene: kit.LayerScene): Promise<Frame> {
    this.live();
    this.followCamera(frame, scene.camera);
    return this.render(frame, scene.camera, scene.msaa, scene.scene);
  }
  protected encode(frame: kit.Encoding, prepared: Frame): void {
    this.painter.encode(frame, prepared.paint, this.style.background);
  }
  protected encodeLayer(frame: kit.Encoding, prepared: Frame): void {
    this.painter.compute(frame.encoder, prepared.paint);
  }
  protected drawLayer(pass: GPURenderPassEncoder, prepared: Frame): void {
    this.painter.draw(pass, prepared.paint);
  }
  protected submitted(frame: FrameInfo, prepared: Frame): void {
    for (const commit of prepared.commits) commit();
    if (!frame.presented) return;
    this.shown = prepared;
    this.counts = prepared.counts;
    this.records.presented();
    this.sources.keep(prepared.live);
  }
  protected release(): void {
    this.shown = undefined;
    this.painter.destroy();
    this.sources.destroy();
    this.records.destroy();
  }

  /** Each record's shapes this frame, from Data, or the vector tiles over the region in view. */
  private plan(
    projector: kit.Projector,
    region: Region,
    config: Geography.Config,
    live: Frame['live'],
  ): Planned[] {
    const planned: Planned[] = [],
      requests = new Map<TileSet, Map<string, { rings: boolean; lines: boolean }>>();
    type Entry = readonly [
      kind: 'area' | 'line',
      type: string,
      options: Geography.AreaOptions | Geography.LineOptions,
    ];
    const entries: Entry[] = [
      ...Object.entries(config.areas ?? {}).map(([type, o]) => ['area', type, o] as Entry),
      ...Object.entries(config.lines ?? {}).map(([type, o]) => ['line', type, o] as Entry),
    ];
    const closedOf = ([kind, type, options]: Entry) =>
      kind === 'area' || strokesRings(options as Geography.LineOptions, config.areas?.[type]);
    // Vector tiles decode the layers every record of theirs names, once.
    for (const entry of entries) {
      const source = entry[2].source ?? config.source;
      if (!isTiles(source) || !this.sources.opened(source)) continue;
      let layers = requests.get(source);
      if (!layers)
        requests.set(source, (layers = new Map<string, { rings: boolean; lines: boolean }>()));
      const layer = layers.get(entry[1]) ?? { rings: false, lines: false };
      if (closedOf(entry)) layer.rings = true;
      else layer.lines = true;
      layers.set(entry[1], layer);
    }
    const placed = new Map<TileSet, Placed<VectorTileData>[]>();
    for (const [tiles, layers] of requests) {
      const request: VectorLayerRequest[] = [...layers]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, kinds]) => ({ name, ...kinds }));
      const pyramid = this.sources.vector(tiles, request),
        seen = new Set<string>(),
        tilesDrawn: Placed<VectorTileData>[] = [];
      // An ancestor standing in for several tiles draws once.
      for (const tile of pyramid.frame(projector, region)) {
        const key = `${tile.from.z}/${tile.from.x}/${tile.from.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tilesDrawn.push(tile);
      }
      placed.set(tiles, tilesDrawn);
      (live.vectors as Set<TileSet>).add(tiles);
    }
    for (const entry of entries) {
      const [kind, type, options] = entry,
        source = options.source ?? config.source;
      if (!source) continue;
      const closed = closedOf(entry),
        field = shapeField(kind, options);
      if (isData(source)) {
        const prepared = this.sources.shapes(
          source,
          type,
          field,
          closed,
          kind === 'line' && (options as Geography.LineOptions).route === 'geodesic',
        );
        if (prepared) {
          (live.shapes as Set<unknown>).add(prepared.shapes);
          planned.push({ kind, type, options, data: source, prepared, whole: false });
        }
        continue;
      }
      if (!isTiles(source)) continue;
      for (const tile of placed.get(source) ?? []) {
        const layer = tile.data.layers.get(type),
          prepared = closed ? layer?.rings : layer?.lines;
        if (prepared)
          planned.push({ kind, type, options, data: tile.data.data, prepared, whole: true });
      }
    }
    // Areas draw beneath lines, each kind in its records' order.
    return [
      ...planned.filter((p) => p.kind === 'area'),
      ...planned.filter((p) => p.kind === 'line'),
    ];
  }
  /** The selection's rows among a Data's rows of a type, as bits; made once per selection. */
  private selected(data: Data, type: string): kit.BufferData | undefined {
    const selection = this.selection;
    if (!selection.length) return undefined;
    if (this.selectionBits?.selection !== selection)
      this.selectionBits = { selection, bits: new WeakMap() };
    const { bits } = this.selectionBits;
    let byType = bits.get(data);
    if (!byType) bits.set(data, (byType = new Map<string, kit.BufferData | null>()));
    if (!byType.has(type)) {
      const places = selection.map((item) => positionIn(data, type, item)).filter((at) => at >= 0);
      if (!places.length) byType.set(type, null);
      else {
        const words = new Uint32Array(Math.max(4, Math.ceil((Math.max(...places) + 1) / 32)));
        for (const at of places) words[at >>> 5] |= 1 << (at & 31);
        const buffer = new kit.BufferData({ size: words.byteLength, label: 'geography selection' });
        buffer.write({ data: words });
        byType.set(type, buffer);
      }
    }
    return byType.get(type) ?? undefined;
  }

  /** Prepare a frame at a camera: what each record draws, its look, the hover, and the labels. */
  private async render(
    frame: kit.Preparation,
    camera: ProjectedCamera,
    msaa: 1 | 4,
    hosted?: GPUBufferBinding,
  ): Promise<Frame> {
    const { config, style } = this.resolved,
      pipeline = await this.framePipelines(frame, msaa),
      projector = new Projector(camera, frame.viewport),
      region = visibleRegion(projector),
      pixels = pixelsPerDegree(projector),
      live: Frame['live'] = { shapes: new Set(), vectors: new Set() };
    const planned = this.plan(projector, region, config, live),
      drawn: Drawn[] = planned.map((p) => ({
        kind: p.kind,
        source: p.data,
        type: p.type,
        shapes: p.prepared.shapes,
        halfWidth:
          p.kind === 'line'
            ? this.records.constant(
                this.records.bind(p.options, LINE),
                style.lineColor,
                style.lineWidthPx,
              ).width / 2
            : 0,
      }));
    const hover = this.hoverFrame(
      frame,
      (point, radius, { check }) => pick(drawn, projector, point, radius, 1, check)[0] ?? null,
    );
    const shapes: ShapeDraw[] = [],
      commits: (() => void)[] = [],
      labels: LabelSource[] = [];
    for (const p of planned) {
      const { kind, type, options, data, prepared } = p,
        level = p.whole ? 0 : levelFor(prepared.shapes, pixels),
        which = kind === 'area' ? 'triangles' : 'strips',
        ranges = p.whole
          ? [0, prepared.shapes.levels[0][which].length]
          : visibleRanges(prepared.shapes, level, region, which);
      if (!ranges.length || !ranges.some((v, i) => i % 2 === 1 && v > 0)) continue;
      const values = options.values ?? data,
        joined = values === data ? undefined : this.sources.join(data, values, type),
        kinds = kind === 'area' ? AREA : LINE,
        color = kind === 'area' ? style.areaColor : style.lineColor,
        // Until the join lands, rows draw their type's look.
        styled =
          values !== data && !joined
            ? this.records.waiting(options, kinds, color, style.lineWidthPx)
            : await this.records.prepare(frame, {
                values,
                type,
                options,
                kinds,
                color,
                width: style.lineWidthPx,
                layout: pipeline.page,
              });
      commits.push(styled.commit);
      const bits = this.selected(data, type),
        at = hover && hover.kind === kind ? positionIn(data, type, hover) : -1,
        hovered = at >= 0 ? at : NONE;
      shapes.push({
        kind,
        type,
        prepared,
        level,
        ranges,
        styled,
        map: joined && frame.buffer(joined),
        selection: bits && frame.buffer(bits),
        hovered,
      });
      if (options.labels)
        labels.push({ data, type, shapes: prepared.shapes, labels: options.labels });
    }
    const batches = labels.length
      ? await this.labels.prepare(frame, this.gpu, labels, projector, region, pixels, style)
      : [];
    const paint = await this.painter.prepare(frame, {
      projector,
      style,
      light: lightOf(style),
      selected: this.selection.length > 0,
      shapes,
      labels: batches,
      pipelines: pipeline,
      shade: this.shadeFrame(frame),
      hosted,
      seconds: this.moving ? (frame.timeMs - (this.clock ??= frame.timeMs)) / 1000 : 0,
    });
    this.live();
    frame.signal.throwIfAborted();
    return {
      paint,
      projector,
      drawn,
      commits,
      live,
      counts: { ...paint.drawn, drawCalls: paint.drawCalls },
    };
  }
}
