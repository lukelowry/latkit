import {
  kit,
  type Gpu,
  type ItemEvents,
  type ItemView,
  type ItemViewConfig,
  type Point,
  type SetOptions,
  type Shade,
  type ViewInput,
  type ViewStats,
  type FrameInfo,
  type Patch,
  type Viewport,
} from '@latkit/gpu';
import { failure, sameIndex, type Data } from '@latkit/model';
import type { Camera, Projection } from './camera.js';
import { DEFAULT_CAMERA, checkCamera, fit, mixCamera, move, zoom } from './camera.js';
import {
  FIELD_OPTIONS,
  networkData,
  type EdgeData,
  type EdgeOptions,
  type NetworkData,
  type NetworkItem,
  type PathData,
  type PathOptions,
  type VertexOptions,
} from './data.js';
import {
  DEFAULT_LIMITS,
  readGeometry,
  vertexOptions,
  edgeOptions,
  type EdgeBank,
  type Geometry,
  type Limits,
  type VertexBank,
} from './geometry/topology.js';
import { indexKey } from './geometry/rows.js';
import { arrow, listen, type Gestures } from './input.js';
import { DEFAULTS, VIEW_DEFAULTS, resolveStyle, type NetworkStyle, type Style } from './options.js';
import { Picking, type PickGeometry } from './picking.js';
import { readFields, resolveDomains, type FieldRead } from './rendering/fields.js';
import { Labels } from './rendering/labels.js';
import { Paths } from './geometry/paths.js';
import { Painter, type Paint, type Reads } from './rendering/painter.js';
import { pipelines, type Pipelines } from './rendering/pipelines.js';

export interface NetworkConfig extends ItemViewConfig, NetworkStyle {
  /** Drawn types by model type name. */
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly paths?: Readonly<Record<string, PathOptions>>;
  /** Where the camera starts; `network.camera` is where it is. Fits the data by default. */
  readonly camera?: Partial<Camera>;
  readonly limits?: Limits;
}
export type NetworkEvents = ItemEvents<NetworkItem, NetworkItem, Camera>;
export interface NetworkStats extends ViewStats {
  readonly vertices: number;
  readonly edges: number;
  /** Logical stroke segments before adaptive GPU tessellation. */
  readonly segments: number;
  readonly geometryBytes: number;
}
type Records = 'vertices' | 'edges' | 'paths';
type Merged = 'camera' | 'input' | 'limits';
export interface Network extends ItemView<
  NetworkConfig,
  NetworkItem,
  NetworkItem,
  Camera,
  NetworkEvents
> {
  set(patch: Patch<NetworkConfig, Records, Merged>, options?: SetOptions): void;
  /** Projections the data supports: the globe needs geographic positions. */
  readonly projections: Readonly<Record<Projection, boolean>>;
  /** The item, the edges at a vertex or the vertices of an edge, and itself. */
  neighborhood(item: NetworkItem): readonly NetworkItem[];
  stats(): NetworkStats;
}

/** Draw a model's vertices, edges, and paths, on a canvas or offscreen. */
export function createNetwork(gpu: Gpu, config: NetworkConfig): Network {
  return new NetworkView(gpu, config);
}

interface Presented {
  readonly geometry: Geometry;
  readonly picking: PickGeometry;
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly height: number;
  readonly data: NetworkData;
  readonly options: Style;
}
interface Pending extends Presented {
  readonly paint: Paint;
}
/** What a config means to the network: its drawn data, limits, and style. */
interface Resolved {
  readonly config: NetworkConfig;
  readonly data: NetworkData;
  readonly limits: Required<Limits>;
  readonly style: Style;
}
/** Hit-test indexes build once the shown positions have held this long, as hover settles. */
const INDEX_SETTLE_MS = 150;
/** Settles after `ms`, when `now` is called, or as soon as the signal aborts. */
function settle(
  ms: number,
  signal: AbortSignal,
): { readonly settled: Promise<void>; readonly now: () => void } {
  let now!: () => void;
  const settled = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    now = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', now, { once: true });
  });
  return { settled, now };
}
/** The drawn data, checked; the base checks every option name and the source. */
function checkData(config: NetworkConfig): NetworkData {
  if (!config.vertices) throw failure('invalid-input', 'Invalid network data');
  const data = networkData(config);
  for (const [type, edge] of Object.entries(data.edges ?? {})) {
    if (
      edge.ends &&
      (edge.ends.length !== 2 ||
        !edge.ends.every((end) => typeof end === 'string') ||
        edge.ends[0] === edge.ends[1])
    )
      throw failure('invalid-input', 'Edge ends must be two distinct fields: ' + type);
    if (edge.ends && edge.junction)
      throw failure('invalid-input', 'A junction centers a net, which has no ends: ' + type);
    if (!edge.ends && edge.bends) throw failure('invalid-input', 'Bends require ends: ' + type);
    checkLine(type, edge);
  }
  for (const [type, path] of Object.entries(data.paths ?? {})) {
    if (!path.points) throw failure('invalid-input', 'A path needs points: ' + type);
    checkLine(type, path);
  }
  for (const vertex of Object.values(data.vertices))
    if (vertex.baseColor) kit.validateRgba(vertex.baseColor);
  return data;
}
/** An edge's or path's own line options. */
function checkLine(type: string, entry: EdgeData | PathData): void {
  if (entry.route && !['straight', 'geodesic'].includes(entry.route))
    throw failure('invalid-input', 'Invalid route: ' + type);
  if (entry.widthPx !== undefined && !(entry.widthPx >= 0 && Number.isFinite(entry.widthPx)))
    throw failure('invalid-input', 'Invalid widthPx: ' + type);
  if (entry.baseColor) kit.validateRgba(entry.baseColor);
}
/** Whether drawn rows or their wiring differ, which rebuilds geometry. */
function rewired(a: NetworkData, b: NetworkData): boolean {
  const differ = <T extends object>(
    x: Readonly<Record<string, T>> | undefined,
    y: Readonly<Record<string, T>> | undefined,
    keys: readonly (keyof T)[],
  ) => {
    const xs = Object.keys(x ?? {}),
      ys = Object.keys(y ?? {});
    return (
      xs.length !== ys.length ||
      xs.some((type, i) => type !== ys[i] || keys.some((key) => x![type][key] !== y![type][key]))
    );
  };
  return (
    topologyChanged(a.source, b.source) ||
    differ(a.vertices, b.vertices, ['rows']) ||
    differ(a.edges, b.edges, ['rows', 'ends', 'junction']) ||
    differ(a.paths, b.paths, ['rows', 'source'])
  );
}

class NetworkView
  extends kit.BaseItemView<
    NetworkConfig,
    NetworkItem,
    NetworkItem,
    Camera,
    NetworkEvents,
    Resolved,
    Pending,
    Pipelines,
    Records,
    Merged
  >
  implements Network
{
  private geometry?: Geometry;
  /** The latest drawn frame: what pick, locate, and selection see. */
  private shown?: Presented;
  private readonly painter: Painter;
  private readonly picking = new Picking();
  /**
   * Hit-test indexes building for the shown positions: in the background once they hold still, or
   * at once for a query that needs them.
   */
  private indexing?: {
    readonly picking: PickGeometry;
    readonly stop: AbortController;
    /** Start building now instead of waiting for the positions to settle. */
    readonly now: () => void;
    /** Settles when the build ends: built, out of budget, superseded, or failed. */
    readonly built: Promise<void>;
    done: boolean;
  };
  private readonly paths = new Paths();
  private readonly labels = new Labels();
  private orbitTime?: number;
  private counts = { vertices: 0, edges: 0, segments: 0, geometryBytes: 0, drawCalls: 0 };
  private readonly gestures: Gestures = {
    pan: (dx, dy) => this.pan(dx, dy),
    rotate: (dx, dy) => {
      const camera = this.camera;
      this.moveCamera(
        {
          projection: camera.projection === 'flat' ? 'tilt' : camera.projection,
          bearing: camera.bearing + dx * 0.4,
          pitch: Math.max(0, Math.min(80, camera.pitch - dy * 0.25)),
          orbit: false,
        },
        {},
      );
    },
    locate: (item) => this.locate(item),
    neighborhood: (item) => this.neighborhood(item),
    reveal: (item) => this.reveal(item),
    selection: () => this.selection,
    choose: (items) => this.choose(items),
  };
  constructor(gpu: Gpu, config: NetworkConfig) {
    super(gpu, config, {
      name: 'network',
      records: ['vertices', 'edges', 'paths'],
      merged: ['camera', 'input', 'limits'],
      fields: FIELD_OPTIONS,
      options: Object.keys(DEFAULTS),
      framed: ['projection', 'center', 'scale', 'pitch', 'bearing'],
      style: VIEW_DEFAULTS,
    });
    this.painter = new Painter(gpu);
    this.start();
  }
  private get data(): NetworkData {
    return this.resolved.data;
  }
  private get style(): Style {
    return this.resolved.style;
  }
  private get limits(): Required<Limits> {
    return this.resolved.limits;
  }

  /** Globe needs geographic positions, which the model's spatial system declares once read. */
  get projections(): Readonly<Record<Projection, boolean>> {
    return { flat: true, tilt: true, globe: this.shown?.geometry.geographic ?? false };
  }
  neighborhood(item: NetworkItem): readonly NetworkItem[] {
    return this.shown?.geometry.adjacency.neighborhood(item, this.shown.data) ?? [];
  }
  stats(): NetworkStats {
    return {
      ...super.stats(),
      ...this.counts,
      pickingBytes: this.shown?.picking.bytes ?? 0,
    };
  }

  protected defaultCamera(): Camera {
    return DEFAULT_CAMERA;
  }
  /** Orbiting needs motion and a tilt: turning it on tilts a flat camera. */
  protected resolveCamera(camera: Camera, current: Camera | undefined): Camera {
    let next: Camera = { ...camera, orbit: camera.orbit && !this.reducedMotion };
    if (next.orbit && !current?.orbit && next.projection === 'flat')
      next = { ...next, projection: 'tilt', pitch: 45 };
    return checkCamera(next);
  }
  /** How a frame's geometry frames items, or all of it. */
  private framing(
    geometry: Geometry,
    picking: PickGeometry,
    items: readonly NetworkItem[] | undefined,
    camera: Camera,
    viewport: Viewport,
  ): Partial<Camera> {
    let bounds = picking.bounds;
    if (items) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const item of items.flatMap((item) =>
        item.kind === 'vertex'
          ? [item]
          : geometry.adjacency
              .neighborhood(item, this.data)
              .filter((near) => near.kind === 'vertex'),
      )) {
        const found = geometry.lookup.get(indexKey(item.index))?.get(item.row);
        if (!found) continue;
        const [x, y] = picking.position(found.value, found.offset);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (minX <= maxX) bounds = [minX, minY, maxX, maxY];
    }
    const { center, scale, pitch, bearing } = fit(bounds, viewport, camera, this.style);
    return { center, scale, pitch, bearing };
  }
  protected interpolate(from: Camera, to: Camera, t: number): Camera | undefined {
    return from.projection === to.projection ? mixCamera(from, to, t) : undefined;
  }
  protected panned(camera: Camera, dx: number, dy: number): Camera {
    return { ...move(camera, dx, dy), orbit: false };
  }
  protected zoomed(camera: Camera, factor: number, anchor: Point, viewport: Viewport): Camera {
    return { ...zoom(camera, factor, anchor, viewport), orbit: false };
  }
  protected position(item: NetworkItem): Point | null {
    const p = this.shown;
    return p ? p.picking.locate(item, p.data, p.camera, p.viewport, p.height) : null;
  }
  protected identify(item: NetworkItem): string {
    return item.kind + ':' + indexKey(item.index) + ':' + item.row;
  }
  protected accept(item: NetworkItem): void {
    const source =
      item.kind === 'path'
        ? (this.data.paths?.[item.index.type]?.source ?? this.data.source)
        : this.data.source;
    const table = source.tables[item.index.type];
    if (!table || !sameIndex(table.index, item.index))
      throw failure('conflict', 'Selection belongs to another source');
  }
  protected contains(item: NetworkItem): boolean {
    const geometry = this.shown?.geometry;
    if (!geometry) return false;
    if (item.kind === 'vertex') return !!geometry.lookup.get(indexKey(item.index))?.get(item.row);
    return geometry.edges.some(
      (bank) =>
        (bank.kind ?? 'edge') === item.kind &&
        sameIndex(bank.index, item.index) &&
        (bank.rows.kind === 'range'
          ? item.row >= bank.rows.offset && item.row < bank.rows.offset + bank.rows.count
          : bank.rows.values.includes(item.row)),
    );
  }
  /** Hits in the shown frame, once the index its positions are building is ready. */
  protected async hits(
    point: Point,
    radiusPx: number,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly NetworkItem[]> {
    const shown = this.shown;
    if (!shown) return [];
    const task = this.indexing;
    if (task && !task.done) {
      task.now();
      if (options.signal) await new kit.Work(options.signal).wait(task.built);
      else await task.built;
    }
    return shown.picking.hit(
      point,
      shown.data,
      shown.camera,
      shown.viewport,
      shown.height,
      shown.options,
      Math.min(radiusPx, Math.hypot(shown.viewport.width, shown.viewport.height)),
    );
  }
  protected pipelines(format: GPUTextureFormat, msaa: 1 | 4, shade: Shade): Promise<Pipelines> {
    return pipelines(this.gpu, format, msaa, shade.wgsl);
  }
  protected listen(
    canvas: HTMLCanvasElement,
    input: kit.CanvasInput,
    mode: NonNullable<ViewInput['mode']>,
  ): void {
    listen(canvas, input, mode, this.gestures);
  }
  protected key(event: KeyboardEvent, mode: NonNullable<ViewInput['mode']>): boolean {
    return arrow(event, mode, this.gestures);
  }

  protected resolve(config: NetworkConfig): Resolved {
    return {
      config,
      data: checkData(config),
      limits: kit.resolveLimits(config.limits, DEFAULT_LIMITS, 'network'),
      style: resolveStyle(config, this.sharedStyle(config)),
    };
  }
  protected configure(next: Resolved, previous: Resolved): void {
    if (
      rewired(previous.data, next.data) ||
      Object.entries(next.limits).some(
        ([key, value]) => previous.limits[key as keyof Limits] !== value,
      )
    ) {
      this.geometry = undefined;
      this.pruneSelection();
    }
    this.invalidate();
  }
  protected get animating(): boolean {
    return super.animating || this.camera.orbit;
  }

  protected async prepare(frame: kit.Preparation): Promise<Pending> {
    this.live();
    const data = this.data,
      style = this.style;
    const topology =
      this.geometry?.native ?? this.geometry ?? (await readGeometry(data, frame, this.limits));
    let geometry = topology;
    const vertices = new Map<VertexBank, FieldRead>(),
      edges = new Map<EdgeBank, FieldRead>();
    for (const bank of geometry.vertices)
      vertices.set(
        bank,
        await readFields(
          frame,
          data.source,
          bank,
          data.vertices[bank.type],
          data.vertices[bank.type].position ?? bank.position,
        ),
      );
    for (const bank of geometry.edges)
      edges.set(
        bank,
        await readFields(
          frame,
          bank.source ?? data.source,
          bank,
          edgeOptions(data, bank),
          undefined,
        ),
      );
    await resolveDomains(frame, data.source, vertices, (bank) =>
      vertexOptions(data, bank as VertexBank),
    );
    await resolveDomains(frame, data.source, edges, (bank) => edgeOptions(data, bank as EdgeBank));
    const compiled = this.paths.prepare(topology, { vertices, edges }, data, this.limits);
    geometry = compiled.geometry;
    for (const [bank, original] of compiled.origins) edges.set(bank, edges.get(original)!);
    for (const bank of geometry.vertices)
      if (bank.synthetic)
        vertices.set(
          bank,
          await readFields(frame, data.source, bank, bank.synthetic, bank.position),
        );
    for (const bank of geometry.vertices)
      if (bank.synthetic) {
        const read = vertices.get(bank)!;
        vertices.set(bank, {
          ...read,
          scales: { height: { domain: [0, 1], range: [0, 1], clamp: true } },
        });
      }
    const reads: Reads = { vertices, edges },
      picking = this.picking.prepare(geometry, reads, this.limits.pickingBytes);
    let camera = await this.frameCamera(frame, (items, current, viewport) =>
      this.framing(geometry, picking, items, current, viewport),
    );
    const framed = camera;
    if (camera.projection === 'globe' && !geometry.geographic)
      camera = { ...camera, projection: 'flat', pitch: 0 };
    // Only presented frames turn the camera; an export draws it where it is.
    if (camera.orbit && frame.presented) {
      const dt =
        this.orbitTime === undefined
          ? 0
          : Math.max(0, Math.min(100, frame.timeMs - this.orbitTime));
      camera = { ...camera, fit: false, bearing: camera.bearing + dt * 0.012 * style.orbitRate };
    }
    if (camera !== framed) this.drawCamera(frame, camera);
    const height =
      style.heightScale *
      (camera.projection === 'globe'
        ? 0.08
        : Math.max(
            picking.bounds[2] - picking.bounds[0],
            picking.bounds[3] - picking.bounds[1],
            1e-6,
          ) * 0.15);
    const pointer = this.pointerPoint;
    this.live();
    frame.signal.throwIfAborted();
    const phases = picking.dashPhases(data, camera, frame.viewport, height);
    const labels = await this.labels.prepare(
      frame,
      this.gpu,
      geometry,
      picking,
      data,
      camera,
      height,
      style,
    );
    const previous = this.shown;
    const moving =
      !!previous &&
      (!picking.samePositions(previous.picking) ||
        height !== previous.height ||
        Object.keys(data.vertices).some(
          (key) => data.vertices[key].height !== previous.data.vertices[key]?.height,
        ));
    const drawnCamera = camera;
    const hover = this.hoverFrame(
      frame,
      (point, radius, { check }) =>
        picking.nearest(point, data, drawnCamera, frame.viewport, height, style, radius, check),
      moving,
    );
    const paint = await this.painter.prepare(frame, {
      pipelines: await this.framePipelines(frame),
      shade: this.shadeFrame(frame),
      camera,
      options: style,
      data,
      geometry,
      reads,
      selection: this.selection,
      hover,
      pointer,
      height,
      labels,
      phases,
    });
    this.live();
    frame.signal.throwIfAborted();
    return {
      geometry,
      picking,
      camera,
      viewport: frame.viewport,
      height,
      data,
      options: style,
      paint,
    };
  }
  protected encode(frame: kit.Encoding, pending: Pending): void {
    this.live();
    this.painter.encode(frame, pending.paint);
  }
  protected submitted(frame: FrameInfo, pending: Pending): void {
    this.geometry = pending.geometry;
    this.painter.prune(pending.geometry);
    // An exported frame leaves what pick, locate, selection, and the orbit see.
    if (!frame.presented) return;
    this.shown = pending;
    this.orbitTime = pending.camera.orbit ? frame.timeMs : undefined;
    this.indexLater(pending);
    this.counts = {
      vertices: pending.geometry.vertexCount,
      edges: pending.geometry.edgeCount,
      segments: pending.geometry.segmentCount,
      geometryBytes: pending.geometry.bytes,
      drawCalls: pending.paint.drawCalls,
    };
  }
  /**
   * Build the shown frame's missing hit-test indexes in cooperative slices once its positions hold
   * still, or at once when a query needs them; new positions or destroy abort the build.
   */
  private indexLater({ picking, camera, data, options }: Presented): void {
    const running = this.indexing;
    if (running && !running.done && running.picking.sameIndexes(picking)) return;
    running?.stop.abort();
    this.indexing = undefined;
    if (camera.projection !== 'flat' || !picking.indexable(data, options)) return;
    const stop = new AbortController(),
      { signal } = stop,
      { settled, now } = settle(INDEX_SETTLE_MS, signal);
    const built = settled
      .then(() => {
        signal.throwIfAborted();
        return picking.indexLater(data, options, new kit.Work(signal));
      })
      .then(
        () => {
          task.done = true;
          // Hover that missed its budget by scanning gets another chance with the index.
          if (!signal.aborted) this.refreshHover();
        },
        (error: unknown) => {
          task.done = true;
          if (!signal.aborted) this.fail(error);
        },
      );
    const task = { picking, stop, now, built, done: false };
    this.indexing = task;
  }
  protected release(): void {
    this.indexing?.stop.abort();
    this.indexing = undefined;
    this.shown = undefined;
    this.geometry = undefined;
    this.painter.destroy();
  }
}

function topologyChanged(a: Data, b: Data): boolean {
  if (a === b) return false;
  if (a.schema !== b.schema || Object.keys(a.tables).length !== Object.keys(b.tables).length)
    return true;
  for (const [name, x] of Object.entries(a.tables)) {
    const y = b.tables[name];
    if (
      !y ||
      x.index.source !== y.index.source ||
      x.index.type !== y.index.type ||
      x.index.version !== y.index.version
    )
      return true;
    if (
      x.rows !== y.rows &&
      (x.rows.kind !== 'range' ||
        y.rows.kind !== 'range' ||
        x.rows.offset !== y.rows.offset ||
        x.rows.count !== y.rows.count)
    )
      return true;
    for (const [field, definition] of Object.entries(a.schema.types[name].fields))
      if (
        typeof definition.type === 'object' &&
        (definition.type.kind === 'reference' || definition.type.kind === 'list') &&
        x.fields[field] !== y.fields[field]
      )
        return true;
  }
  return false;
}
