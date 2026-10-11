import {
  kit,
  type Gpu,
  type ItemEvents,
  type ItemView,
  type ItemViewOptions,
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
  type AreaOptions,
  type GeographyStyle,
  type LineOptions,
  type Style,
} from './options.js';
import { shapeField, strokesRings } from './pack.js';
import { pick, type Drawn, type GeographyItem } from './picking.js';
import { isTiles, type TileSet, type Tiles } from './tiles.js';
import { Labels, type LabelSource } from './scene/labels.js';
import { RecordStyles } from './scene/records.js';
import { Sources, type Prepared, type VectorTileData } from './scene/sources.js';
import type { Placed } from './scene/pyramid.js';
import { levelFor, pixelsPerDegree, visibleRanges, visibleRegion } from './scene/visible.js';
import type { VectorLayerRequest } from './sources/vector.js';
import { Painter, type Paint, type ShapeDraw } from './rendering/painter.js';
import { pipelines, type Pipelines } from './rendering/pipelines.js';

const { Projector } = kit;
const NONE = 0xffffffff;

export interface GeographyLimits {
  /** GPU bytes loaded tiles may hold, each source, before the least recently drawn go. */
  readonly tileBytes?: number;
  /** Tile requests in flight at once, each source. */
  readonly requests?: number;
}
const DEFAULT_LIMITS: Required<GeographyLimits> = Object.freeze({
  tileBytes: 64 * 1024 ** 2,
  requests: 8,
});
export interface GeographyConfig extends ItemViewOptions, GeographyStyle {
  /** Where areas and lines read their shapes and fields: Data, or tiles. A record may name its own. */
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
export interface Geography
  extends ItemView<GeographyConfig, GeographyItem, GeographyItem, ProjectedCamera, GeographyEvents> {
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
}
/** A record this frame resolved: what it draws from, before its look. */
interface Planned {
  readonly kind: 'area' | 'line';
  readonly type: string;
  readonly options: AreaOptions | LineOptions;
  readonly data: Data;
  readonly prepared: Prepared;
  /** A tile's shapes draw whole; Data's and packs' by what is in view. */
  readonly whole: boolean;
}
interface Frame {
  readonly paint: Paint;
  readonly projector: kit.Projector;
  readonly drawn: readonly Drawn[];
  readonly commits: readonly (() => void)[];
  readonly live: Parameters<Sources['keep']>[0];
  readonly counts: { readonly vertices: number; readonly triangles: number; readonly drawCalls: number };
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
  /** Each row space's selection, a bit per row, made again when the selection changes. */
  private selectionBits?: {
    readonly selection: readonly GeographyItem[];
    readonly bits: Map<Data, Map<string, kit.BufferData>>;
  };
  private counts = { vertices: 0, triangles: 0, drawCalls: 0 };
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
  /** The drawn record an item belongs to. */
  private recordOf(item: GeographyItem): Drawn | undefined {
    return this.shown?.drawn.find(
      (d) => d.kind === item.kind && d.source === item.source && d.type === item.index.type,
    );
  }
  private positionOf(record: Drawn, item: GeographyItem): number {
    const rows = record.source.tables[record.type].rows;
    return rows.kind === 'range' ? item.row - rows.offset : rows.values.indexOf(item.row);
  }
  protected position(item: GeographyItem): Point | null {
    const record = this.recordOf(item),
      shown = this.shown;
    if (!record || !shown) return null;
    const at = this.positionOf(record, item),
      x = record.shapes.anchors[at * 2],
      y = record.shapes.anchors[at * 2 + 1];
    if (!Number.isFinite(x)) return null;
    const p = shown.projector.project(x, y);
    return p.visible ? [p.x, p.y] : null;
  }
  protected identify(item: GeographyItem): string {
    return itemKey(item, item.kind);
  }
  protected contains(item: GeographyItem): boolean {
    const record = this.recordOf(item);
    if (!record) return false;
    const at = this.positionOf(record, item);
    return at >= 0 && at < record.shapes.rows;
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
    };
  }
  protected configure(next: Resolved, previous: Resolved): void {
    if (
      next.config.source !== previous.config.source ||
      next.config.areas !== previous.config.areas ||
      next.config.lines !== previous.config.lines
    )
      this.pruneSelection();
    this.invalidate();
  }
  protected get pending(): Promise<void> | undefined {
    return this.sources.pending;
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
      for (const item of items) {
        const record = this.recordOf(item);
        if (record) add(record.shapes.bounds, this.positionOf(record, item) * 4);
      }
    } else {
      for (const record of this.shown?.drawn ?? []) add(record.shapes.extent);
      const { config } = this.resolved;
      for (const tiles of this.tileSets(config)) {
        const source = this.sources.opened(tiles);
        if (source && source.kind !== 'pack') add(source.bounds);
      }
    }
    if (!(w <= e)) return undefined;
    const { center, scale } = Projector.fit(camera, [w, s, e, n], viewport, this.style.fitPaddingPx, {
      pitch: 0,
      bearing: 0,
    });
    return { center, scale };
  }
  private tileSets(config: GeographyConfig): TileSet[] {
    const out = new Set<TileSet>();
    const add = (source: unknown) => {
      if (isTiles(source)) out.add(source);
    };
    add(config.source);
    for (const options of [...Object.values(config.areas ?? {}), ...Object.values(config.lines ?? {})])
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

  /** Each record's shapes this frame, from Data, a pack, or the vector tiles in view. */
  private plan(
    projector: kit.Projector,
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
      if (!isTiles(source) || this.sources.opened(source)?.kind !== 'vector') continue;
      let layers = requests.get(source);
      if (!layers) requests.set(source, (layers = new Map()));
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
      for (const tile of pyramid.frame(projector)) {
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
      const opened = this.sources.opened(source);
      if (opened?.kind === 'pack') {
        (live.packs as Set<TileSet>).add(source);
        const pack = this.sources.pack(source),
          prepared = pack && this.sources.packShapes(pack, type, field, closed);
        if (pack && prepared) {
          (live.shapes as Set<unknown>).add(prepared.shapes);
          planned.push({ kind, type, options, data: pack.data, prepared, whole: false });
        }
      } else if (opened?.kind === 'vector')
        for (const tile of placed.get(source) ?? []) {
          const layer = tile.data.layers.get(type),
            prepared = closed ? layer?.rings : layer?.lines;
          if (prepared) planned.push({ kind, type, options, data: tile.data.data, prepared, whole: true });
        }
    }
    // Areas draw beneath lines, each kind in its records' order.
    return [...planned.filter((p) => p.kind === 'area'), ...planned.filter((p) => p.kind === 'line')];
  }
  /** Each row space's selection bits, built once per selection. */
  private selected(data: Data, type: string): kit.BufferData | undefined {
    const selection = this.selection;
    if (!selection.length) return undefined;
    if (this.selectionBits?.selection !== selection) {
      const bits = new Map<Data, Map<string, kit.BufferData>>(),
        positions = new Map<Data, Map<string, number[]>>();
      for (const item of selection) {
        const table = item.source.tables[item.index.type];
        if (!table) continue;
        const rows = table.rows,
          at = rows.kind === 'range' ? item.row - rows.offset : rows.values.indexOf(item.row);
        let byType = positions.get(item.source);
        if (!byType) positions.set(item.source, (byType = new Map()));
        const list = byType.get(item.index.type) ?? [];
        list.push(at);
        byType.set(item.index.type, list);
      }
      for (const [source, byType] of positions)
        for (const [name, list] of byType) {
          const words = new Uint32Array(Math.max(4, Math.ceil((Math.max(...list) + 1) / 32)));
          for (const at of list) if (at >= 0) words[at >>> 5] |= 1 << (at & 31);
          const buffer = new kit.BufferData({ size: words.byteLength, label: 'geography selection' });
          buffer.write({ data: words });
          let byName = bits.get(source);
          if (!byName) bits.set(source, (byName = new Map()));
          byName.set(name, buffer);
        }
      this.selectionBits = { selection, bits };
    }
    return this.selectionBits.bits.get(data)?.get(type);
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
      live: Frame['live'] = { shapes: new Set(), vectors: new Set(), packs: new Set() };
    const planned = this.plan(projector, config, live),
      drawn: Drawn[] = planned.map((p) => ({
        kind: p.kind,
        source: p.data,
        type: p.type,
        shapes: p.prepared.shapes,
        halfWidth:
          p.kind === 'line'
            ? this.records.constant(this.records.bind(p.options, LINE), style.lineColor, style.lineWidthPx)
                .width / 2
            : 0,
      }));
    const hover = this.hoverFrame(frame, (point, radius, { check }) =>
      pick(drawn, projector, point, radius, 1, check)[0] ?? null,
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
        hovered =
          hover && hover.kind === kind && hover.source === data && hover.index.type === type
            ? (() => {
                const rows = data.tables[type].rows;
                return rows.kind === 'range' ? hover.row - rows.offset : rows.values.indexOf(hover.row);
              })()
            : NONE;
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
      if (options.labels) labels.push({ data, type, shapes: prepared.shapes, labels: options.labels });
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
