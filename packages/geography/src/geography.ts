import {
  kit,
  type Gpu,
  type ItemEvents,
  type ItemView,
  type ItemViewConfig,
  type Patch,
  type Point,
  type ProjectedCamera,
  type SetOptions,
  type Shade,
  type ViewInput,
  type ViewStats,
  type FrameInfo,
  type Viewport,
} from '@latkit/gpu';
import { failure, itemKey, type Data } from '@latkit/model';
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
  type AreaOptions,
  type GeographyStyle,
  type LineOptions,
  type Style,
} from './options.js';
import { pick, positionIn, type Drawn, type GeographyItem } from './picking.js';
import { isTiles, type TileSet, type Tiles } from './tiles.js';
import { Labels, type LabelSource } from './scene/labels.js';
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

const { Projector } = kit;
const NONE = 0xffffffff;

export interface GeographyLimits {
  /** GPU bytes loaded tiles may hold, each source, before the least recently drawn go. */
  readonly tileBytes?: number;
  /** Tile requests in flight at once, each source. */
  readonly tileRequests?: number;
}
const DEFAULT_LIMITS: Required<GeographyLimits> = Object.freeze({
  tileBytes: 64 * 1024 ** 2,
  tileRequests: 8,
});
export interface GeographyConfig extends ItemViewConfig, GeographyStyle {
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
  readonly limits?: GeographyLimits;
}
export type GeographyEvents = ItemEvents<GeographyItem, GeographyItem, ProjectedCamera>;
export interface GeographyStats extends ViewStats {
  /** Tiles loaded, and still loading. */
  readonly tiles: number;
  readonly loading: number;
  /** Vertices the latest frame drew, three a triangle and two a line point, and its triangles. */
  readonly vertices: number;
  readonly triangles: number;
  /** GPU bytes the shapes and tiles hold. */
  readonly geometryBytes: number;
}
type Records = 'areas' | 'lines';
type Merged = 'camera' | 'input' | 'limits';
export interface Geography extends ItemView<
  GeographyConfig,
  GeographyItem,
  GeographyItem,
  ProjectedCamera,
  GeographyEvents
> {
  set(patch: Patch<GeographyConfig, Records, Merged>, options?: SetOptions): void;
  stats(): GeographyStats;
}

/** Draw the earth and what lies on it: on a canvas, offscreen, or beneath a network. */
export function createGeography(gpu: Gpu, config: GeographyConfig = {}): Geography {
  return new GeographyView(gpu, config);
}

interface Resolved {
  readonly config: GeographyConfig;
  readonly style: Style;
  readonly limits: Required<GeographyLimits>;
  /** Whether any line type moves comets along itself. */
  readonly flowing: boolean;
}
/** A record this frame resolved: what it draws from, before its look. */
interface Planned {
  readonly kind: 'area' | 'line';
  readonly type: string;
  readonly options: AreaOptions | LineOptions;
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
function warmFor(config: GeographyConfig): void {
  if (Object.keys(config.areas ?? {}).length || Object.keys(config.lines ?? {}).length) warm();
}
class GeographyView
  extends kit.BaseItemView<
    GeographyConfig,
    GeographyItem,
    GeographyItem,
    ProjectedCamera,
    GeographyEvents,
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
  private readonly labels = new Labels();
  /** The latest drawn frame: what pick, locate, and selection see. */
  private shown?: Frame;
  /** The selection's rows in each drawn Data, a bit per row, made as frames first draw them. */
  private selectionBits?: {
    readonly selection: readonly GeographyItem[];
    readonly bits: WeakMap<Data, Map<string, kit.BufferData | null>>;
  };
  private counts = { vertices: 0, triangles: 0, drawCalls: 0 };
  /** When comets began to move, in the frames' clock. */
  private clock?: number;
  constructor(gpu: Gpu, config: GeographyConfig) {
    super(gpu, config, {
      name: 'geography',
      records: ['areas', 'lines'],
      merged: ['camera', 'input', 'limits'],
      options: [...Object.keys(DEFAULTS), 'limits'],
      framed: ['projection', 'center', 'scale', 'pitch', 'bearing'],
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
  private get style(): Style {
    return this.resolved.style;
  }
  stats(): GeographyStats {
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
  protected resolveCamera(camera: ProjectedCamera): ProjectedCamera {
    return Projector.check({ ...camera, orbit: false });
  }
  protected interpolate(
    from: ProjectedCamera,
    to: ProjectedCamera,
    t: number,
  ): ProjectedCamera | undefined {
    return from.projection === to.projection ? Projector.mix(from, to, t) : undefined;
  }
  protected panned(camera: ProjectedCamera, dx: number, dy: number): ProjectedCamera {
    return Projector.move(camera, dx, dy);
  }
  protected zoomed(
    camera: ProjectedCamera,
    factor: number,
    anchor: Point,
    viewport: Viewport,
  ): ProjectedCamera {
    return Projector.zoom(camera, factor, anchor, viewport);
  }
  /** Where the drawn records hold an item: each record, and the item's place in its rows. */
  private placements(item: GeographyItem): { readonly record: Drawn; readonly at: number }[] {
    const out: { record: Drawn; at: number }[] = [];
    for (const record of this.shown?.drawn ?? [])
      if (record.kind === item.kind && record.type === item.index.type) {
        const at = positionIn(record.source, record.type, item);
        if (at >= 0 && at < record.shapes.rows) out.push({ record, at });
      }
    return out;
  }
  protected position(item: GeographyItem): Point | null {
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
  protected identify(item: GeographyItem): string {
    return itemKey(item, item.kind);
  }
  protected contains(item: GeographyItem): boolean {
    return this.placements(item).length > 0;
  }
  protected hits(
    point: Point,
    radiusPx: number,
    options: { readonly limit: number },
  ): readonly GeographyItem[] {
    const shown = this.shown;
    return shown ? pick(shown.drawn, shown.projector, point, radiusPx, options.limit) : [];
  }
  protected pipelines(format: GPUTextureFormat, msaa: 1 | 4, shade: Shade): Promise<Pipelines> {
    return pipelines(this.gpu, format, msaa, shade.wgsl);
  }
  /** The right button, or Shift, turns the camera: a plane tilts, the mercator plane only turns. */
  protected grab(
    event: PointerEvent,
    point: Point,
    mode: NonNullable<ViewInput['mode']>,
  ): kit.Grab | undefined {
    if (mode === 'inspect' || (event.button !== 2 && !event.shiftKey)) return undefined;
    let last = point;
    return {
      move: (next) => {
        const camera = this.camera,
          dx = next[0] - last[0],
          dy = next[1] - last[1];
        last = next;
        this.moveCamera(
          {
            projection: camera.projection === 'flat' ? 'tilt' : camera.projection,
            bearing: camera.bearing + dx * 0.4,
            pitch: Math.max(0, Math.min(80, camera.pitch - dy * 0.25)),
          },
          {},
        );
      },
      end() {},
    };
  }

  protected resolve(config: GeographyConfig): Resolved {
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
    items: readonly GeographyItem[] | undefined,
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
    if (!(w <= e)) return undefined;
    const { center, scale } = Projector.fit(
      camera,
      [w, s, e, n],
      viewport,
      this.style.fitPaddingPx,
      {
        pitch: 0,
        bearing: 0,
      },
    );
    return { center, scale };
  }
  private tileSets(config: GeographyConfig): TileSet[] {
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
    return this.render(frame, camera, this.style.msaa);
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
    config: GeographyConfig,
    live: Frame['live'],
  ): Planned[] {
    const planned: Planned[] = [],
      requests = new Map<TileSet, Map<string, { rings: boolean; lines: boolean }>>();
    type Entry = readonly [kind: 'area' | 'line', type: string, options: AreaOptions | LineOptions];
    const entries: Entry[] = [
      ...Object.entries(config.areas ?? {}).map(([type, o]) => ['area', type, o] as Entry),
      ...Object.entries(config.lines ?? {}).map(([type, o]) => ['line', type, o] as Entry),
    ];
    const closedOf = ([kind, type, options]: Entry) =>
      kind === 'area' || strokesRings(options as LineOptions, config.areas?.[type]);
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
          kind === 'line' && (options as LineOptions).route === 'geodesic',
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
