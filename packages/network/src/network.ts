import {
  kit,
  type Gpu,
  type ItemEvents,
  type ItemView,
  type ItemViewConfig,
  type Point,
  type ProjectedCamera,
  type Projection,
  type SetOptions,
  type Shade,
  type View,
  type ViewInput,
  type ViewStats,
  type FrameInfo,
  type LayoutOptions,
  type Patch,
  type Positions,
  type Viewport,
} from '@latkit/gpu';
import {
  Work,
  failure,
  sameIndex,
  type Data,
  type RequestOptions,
  type TypeDefinition,
} from '@latkit/model';
import {
  networkData,
  networkKey,
  type EdgeOptions,
  type NetworkData,
  type NetworkItem,
  type VertexOptions,
} from './data.js';
import {
  DEFAULT_LIMITS,
  placement,
  readGeometry,
  vertexOptions,
  edgeOptions,
  type EdgeBank,
  type Geometry,
  type Limits,
  type VertexBank,
} from './geometry/topology.js';
import { indexKey } from './geometry/rows.js';
import { Placement, arrangeVertices, positions } from './geometry/layout.js';
import { arrow, type Gestures } from './input.js';
import { DEFAULTS, VIEW_DEFAULTS, resolveStyle, type NetworkStyle, type Style } from './options.js';
import { Picking, type PickGeometry } from './picking.js';
import {
  LINE,
  VERTEX,
  channels,
  readFields,
  resolveDomains,
  type FieldRead,
} from './rendering/fields.js';
import { Labels } from './rendering/labels.js';
import { Routes } from './geometry/routes.js';
import { Painter, type Paint, type Reads } from './rendering/painter.js';
import { pipelines, type Pipelines } from './rendering/pipelines.js';

const { Projector, PROJECTIONS } = kit;
/**
 * Each network's geographies as layers. Resolving a config makes them, and resolving runs while the
 * base view constructs, before a network's own fields exist.
 */
const grounds = new WeakMap<object, Map<View, kit.Layer>>();

export interface NetworkConfig extends ItemViewConfig, NetworkStyle {
  /** Borrowed: destroy never closes it. */
  readonly source: Data;
  /** Drawn types by model type name. */
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  /**
   * A geography drawn beneath the graph, in its pass, with its camera, `at`, and depth: the earth
   * and what lies on it. Its sun lights the graph, and input the graph leaves reaches it.
   */
  readonly geography?: View | null;
  /**
   * How vertices without a position are placed: by `stress` by default, each edge as long as the
   * positioned ones' median, or 1 without any.
   */
  readonly layout?: LayoutOptions;
  /** Where the camera starts; `network.camera` is where it is. Fits the data by default. */
  readonly camera?: Partial<ProjectedCamera>;
  readonly limits?: Limits;
}
export type NetworkEvents = ItemEvents<NetworkItem, NetworkItem, ProjectedCamera>;
export interface NetworkStats extends ViewStats {
  readonly vertices: number;
  readonly edges: number;
  /** Logical stroke segments before adaptive GPU tessellation. */
  readonly segments: number;
  readonly geometryBytes: number;
}
type Records = 'vertices' | 'edges';
type Merged = 'camera' | 'input' | 'limits' | 'layout';
export interface Network extends ItemView<
  NetworkConfig,
  NetworkItem,
  NetworkItem,
  ProjectedCamera,
  NetworkEvents
> {
  set(patch: Patch<NetworkConfig, Records, Merged>, options?: SetOptions): void;
  /** Projections the data supports: the globe and the mercator plane need geographic positions. */
  readonly projections: Readonly<Record<Projection, boolean>>;
  /** The item, the edges at a vertex or the vertices of an edge, and itself. */
  neighborhood(item: NetworkItem): readonly NetworkItem[];
  stats(): NetworkStats;
}

/** Draw a model's vertices and edges, on a canvas or offscreen. */
export function createNetwork(gpu: Gpu, config: NetworkConfig): Network {
  return new NetworkView(gpu, config);
}
/** Place a network's vertices as it would, without drawing: positions by vertex type. */
export async function arrange(
  gpu: Gpu,
  config: NetworkConfig,
  options: RequestOptions = {},
): Promise<Readonly<Record<string, Positions>>> {
  const data = checkData(config),
    limits = kit.resolveLimits(config.limits, DEFAULT_LIMITS, 'network'),
    layout = checkLayout(config.layout),
    reader = gpu.reader.open({ signal: options.signal, at: config.at ?? undefined });
  try {
    const work = new Work(reader.signal, limits.layoutMs),
      topology = await readGeometry(data, reader, limits);
    return positions(topology, await arrangeVertices(reader, topology, data, layout, work));
  } finally {
    reader.close();
  }
}

interface Presented {
  readonly geometry: Geometry;
  readonly picking: PickGeometry;
  /** The frame's camera on its viewport. */
  readonly projector: kit.Projector;
  readonly height: number;
  readonly data: NetworkData;
  readonly options: Style;
}
interface Pending extends Presented {
  readonly paint: Paint;
  /** Whether the frame begins the transition in progress. */
  readonly begins: boolean;
}
/** What a config means to the network: its drawn data, limits, layout, style, and ground. */
interface Resolved {
  readonly config: NetworkConfig;
  readonly data: NetworkData;
  readonly limits: Required<Limits>;
  readonly layout: LayoutOptions;
  readonly style: Style;
  /** Whether any edge type moves dots along itself. */
  readonly flowing: boolean;
  /** The geography drawn beneath, as a layer. */
  readonly ground?: kit.Layer;
}
/** Style a transition eases, as rows read it where they have no value of their own. */
const EASED = ['vertexColor', 'vertexRadiusPx', 'edgeColor', 'edgeWidthPx'] as const;
/**
 * Hit-test indexes build once the shown positions and the camera have held this long, as hover
 * settles: never while the camera moves, when frames are being drawn and hover waits anyway.
 */
const INDEX_SETTLE_MS = 150;
/** Settles `ms` after its latest `touch`, when `now` is called, or as soon as the signal aborts. */
function settle(
  ms: number,
  signal: AbortSignal,
): { readonly settled: Promise<void>; readonly now: () => void; readonly touch: () => void } {
  let resolve!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<void>((done) => (resolve = done));
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(resolve, ms);
  };
  const now = () => {
    clearTimeout(timer);
    resolve();
  };
  touch();
  signal.addEventListener('abort', now, { once: true });
  return { settled, now, touch };
}
/** Whether two cameras show the same view. */
function sameView(a: ProjectedCamera, b: ProjectedCamera): boolean {
  return (
    a.projection === b.projection &&
    a.center[0] === b.center[0] &&
    a.center[1] === b.center[1] &&
    a.scale === b.scale &&
    a.pitch === b.pitch &&
    a.bearing === b.bearing
  );
}
/** The drawn data, checked; the base checks every option name and the source. */
function checkData(config: NetworkConfig): NetworkData {
  if (!config.vertices) throw failure('invalid-input', 'Invalid network data');
  const data = networkData(config);
  for (const vertex of Object.values(data.vertices)) {
    if (vertex.marker !== undefined) kit.checkMarker(vertex.marker);
    channels(vertex, VERTEX);
    kit.resolveLabels(vertex.labels);
  }
  for (const [type, edge] of Object.entries(data.edges ?? {})) {
    if (
      edge.ends &&
      (edge.ends.length !== 2 ||
        !edge.ends.every((end) => typeof end === 'string') ||
        edge.ends[0] === edge.ends[1])
    )
      throw failure('invalid-input', 'Edge ends must be two distinct fields: ' + type);
    if (edge.ends && (edge.x != null || edge.y != null))
      throw failure('invalid-input', 'A star center belongs to a net, which has no ends: ' + type);
    if (!edge.ends && edge.bends) throw failure('invalid-input', 'Bends require ends: ' + type);
    if (edge.route && !['straight', 'geodesic'].includes(edge.route))
      throw failure('invalid-input', 'Invalid route: ' + type);
    channels(edge, LINE);
    kit.resolveLabels(edge.labels);
  }
  return data;
}
const NO_LAYOUT: LayoutOptions = Object.freeze({});
/** The layout options, checked. */
function checkLayout(layout: LayoutOptions | undefined): LayoutOptions {
  kit.layoutOptions(layout, { algorithm: 'stress', vertexGap: 1, rankGap: 3 });
  return layout ?? NO_LAYOUT;
}
/** Whether a net centers its stars on its own x and y. */
function centered(edge: EdgeOptions | undefined): boolean {
  return edge?.x != null || edge?.y != null;
}
/**
 * Whether drawn rows, their wiring, or how they are placed differ, which rebuilds geometry. New
 * positions of the same kind, as a live simulation binds each frame, never do.
 */
function rewired(a: NetworkData, b: NetworkData): boolean {
  return !(
    kit.sameValues(a.source, b.source, wiring) &&
    kit.sameRecords(a.vertices, b.vertices, ['rows']) &&
    kit.sameRecords(a.edges, b.edges, ['rows', 'ends']) &&
    Object.keys(b.vertices).every(
      (type) =>
        placement(a.source, type, a.vertices[type]) === placement(b.source, type, b.vertices[type]),
    ) &&
    Object.keys(b.edges ?? {}).every(
      (type) => centered(a.edges?.[type]) === centered(b.edges![type]),
    )
  );
}

class NetworkView
  extends kit.BaseItemView<
    NetworkConfig,
    NetworkItem,
    NetworkItem,
    ProjectedCamera,
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
    /** Wait a settle again before building: the camera moved. */
    readonly touch: () => void;
    /** The camera the latest presented frame showed. */
    camera: ProjectedCamera;
    /** Settles when the build ends: built, out of budget, superseded, or failed. */
    readonly built: Promise<void>;
    done: boolean;
  };
  private readonly routes = new Routes();
  private readonly placement = new Placement();
  private readonly labels = new Labels();
  /** The ground's invalidations, which this view follows. */
  private following?: () => void;
  /** The ground captured with this view's frame. */
  private captured?: kit.CapturedLayer;
  /** An animated `set` eases its drawn values from what the next presented frame replaces. */
  private transitionRequested = false;
  /**
   * The transition in progress: when it started, where picking saw rows as it did, and whether a
   * frame has drawn its start.
   */
  private transition?: { readonly start: number; readonly from: PickGeometry; begun: boolean };
  private orbitTime?: number;
  private counts = { vertices: 0, edges: 0, segments: 0, geometryBytes: 0, drawCalls: 0 };
  private readonly gestures: Gestures = {
    pan: (dx, dy) => this.pan(dx, dy),
    rotate: (dx, dy) => {
      const camera = this.camera;
      // A flat plane tilts to turn; the mercator plane only turns, staying flat.
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
      records: ['vertices', 'edges'],
      merged: ['camera', 'input', 'limits', 'layout'],
      options: [...Object.keys(DEFAULTS), 'geography'],
      framed: ['projection', 'center', 'scale', 'pitch', 'bearing'],
      style: VIEW_DEFAULTS,
    });
    this.painter = new Painter(gpu);
    this.ground = this.resolved.ground;
    this.follow(this.ground);
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
  private get layout(): LayoutOptions {
    return this.resolved.layout;
  }

  /** The globe and the mercator plane need geographic positions, which their fields declare once read. */
  get projections(): Readonly<Record<Projection, boolean>> {
    const geographic = this.shown?.geometry.geographic ?? false;
    return { flat: true, tilt: true, mercator: geographic, globe: geographic };
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

  /** Geographic positions start on the mercator plane, as a geography does; others on the plane. */
  protected defaultCamera(): ProjectedCamera {
    const { data } = this.resolved;
    return Object.entries(data.vertices).some(
      ([type, options]) => placement(data.source, type, options) === 'geographic',
    )
      ? { ...Projector.camera, projection: 'mercator' }
      : Projector.camera;
  }
  /** Orbiting needs motion and a tilt: turning it on tilts a flat camera. */
  protected resolveCamera(
    camera: ProjectedCamera,
    current: ProjectedCamera | undefined,
  ): ProjectedCamera {
    let next: ProjectedCamera = { ...camera, orbit: camera.orbit && !this.reducedMotion };
    if (next.orbit && !current?.orbit && next.projection === 'flat')
      next = { ...next, projection: 'tilt', pitch: 45 };
    return Projector.check(next);
  }
  /** How a frame's geometry frames items, or all of it. */
  private framing(
    geometry: Geometry,
    picking: PickGeometry,
    items: readonly NetworkItem[] | undefined,
    camera: ProjectedCamera,
    viewport: Viewport,
  ): Partial<ProjectedCamera> {
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
    const { center, scale, pitch, bearing } = Projector.fit(
      camera,
      bounds,
      viewport,
      this.style.fitPaddingPx,
      { pitch: this.style.fitPitch, bearing: this.style.fitBearing },
    );
    return { center, scale, pitch, bearing };
  }
  protected interpolate(
    from: ProjectedCamera,
    to: ProjectedCamera,
    t: number,
  ): ProjectedCamera | undefined {
    return from.projection === to.projection ? Projector.mix(from, to, t) : undefined;
  }
  protected panned(camera: ProjectedCamera, dx: number, dy: number): ProjectedCamera {
    return { ...Projector.move(camera, dx, dy), orbit: false };
  }
  protected zoomed(
    camera: ProjectedCamera,
    factor: number,
    anchor: Point,
    viewport: Viewport,
  ): ProjectedCamera {
    return { ...Projector.zoom(camera, factor, anchor, viewport), orbit: false };
  }
  protected position(item: NetworkItem): Point | null {
    const p = this.shown;
    return p ? p.picking.locate(item, p.data, p.projector, p.height, p.options) : null;
  }
  protected identify(item: NetworkItem): string {
    return networkKey(item);
  }
  protected accept(item: NetworkItem): void {
    const table = this.data.source.tables[item.index.type];
    if (!table || !sameIndex(table.index, item.index))
      throw failure('conflict', 'Selection belongs to another source');
  }
  protected contains(item: NetworkItem): boolean {
    const geometry = this.shown?.geometry;
    if (!geometry) return false;
    if (item.kind === 'vertex') return !!geometry.lookup.get(indexKey(item.index))?.get(item.row);
    return geometry.edges.some(
      (bank) =>
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
    options: { readonly limit: number; readonly signal?: AbortSignal },
  ): Promise<readonly NetworkItem[]> {
    const shown = this.shown;
    if (!shown) return [];
    const task = this.indexing;
    if (task && !task.done) {
      task.now();
      if (options.signal) await new Work(options.signal).wait(task.built);
      else await task.built;
    }
    const { viewport } = shown.projector;
    return shown.picking.hit(
      point,
      shown.data,
      shown.projector,
      shown.height,
      shown.options,
      Math.min(radiusPx, Math.hypot(viewport.width, viewport.height)),
      options.limit,
    );
  }
  protected pipelines(format: GPUTextureFormat, msaa: 1 | 4, shade: Shade): Promise<Pipelines> {
    return pipelines(this.gpu, format, msaa, shade.wgsl);
  }
  /** The right button, or Shift, turns the camera; any other press pans as every view does. */
  protected grab(
    event: PointerEvent,
    point: Point,
    mode: NonNullable<ViewInput['mode']>,
  ): kit.Grab | undefined {
    if (mode === 'inspect' || (event.button !== 2 && !event.shiftKey)) return undefined;
    let last = point;
    return {
      move: (next) => {
        this.gestures.rotate(next[0] - last[0], next[1] - last[1]);
        last = next;
      },
      end() {},
    };
  }
  protected key(event: KeyboardEvent, mode: NonNullable<ViewInput['mode']>): boolean {
    return arrow(event, mode, this.gestures);
  }

  protected resolve(config: NetworkConfig): Resolved {
    return {
      config,
      data: checkData(config),
      limits: kit.resolveLimits(config.limits, DEFAULT_LIMITS, 'network'),
      layout: checkLayout(config.layout),
      flowing: Object.values(config.edges ?? {}).some(
        (line) => line.flowPx != null && line.flowPx !== 0,
      ),
      style: resolveStyle(config, this.sharedStyle(config)),
      ground: this.layerOf(config.geography),
    };
  }
  /**
   * A geography as a layer, made once for each: a view that cannot be drawn beneath another, or
   * that presents elsewhere, rejects the config here, before any of it applies.
   */
  private layerOf(view: View | null | undefined): kit.Layer | undefined {
    if (!view) return undefined;
    let layers = grounds.get(this);
    if (!layers) grounds.set(this, (layers = new Map<View, kit.Layer>()));
    let layer = layers.get(view);
    if (!layer) layers.set(view, (layer = kit.layerOf(view)));
    return layer;
  }
  /** Follow the ground's invalidations, and let go of any geography no longer drawn. */
  private follow(ground: kit.Layer | undefined): void {
    this.following?.();
    this.following = ground?.invalidated(() => this.invalidate());
    const layers = grounds.get(this);
    for (const [view, layer] of layers ?? [])
      if (layer !== ground) {
        layer.release();
        layers!.delete(view);
      }
  }
  protected configure(next: Resolved, previous: Resolved, options: SetOptions): void {
    const a = previous.data,
      b = next.data;
    if (next.ground !== previous.ground) {
      this.follow(next.ground);
      this.ground = next.ground;
    }
    if (
      options.animate &&
      (a.source !== b.source ||
        a.vertices !== b.vertices ||
        a.edges !== b.edges ||
        previous.layout !== next.layout ||
        EASED.some((key) => String(previous.style[key]) !== String(next.style[key])))
    )
      this.transitionRequested = true;
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
  /** Orbiting turns the camera, flow moves, transitions and hover ease, and the ground loads. */
  protected get animating(): boolean {
    return (
      super.animating ||
      this.camera.orbit ||
      !!this.transition ||
      this.painter.growing ||
      (this.resolved.flowing && this.style.lines && !this.reducedMotion) ||
      !!this.resolved.ground?.animating
    );
  }
  protected get pending(): Promise<void> | undefined {
    return this.resolved.ground?.pending;
  }
  /** The ground is captured with the network's own frame, and released with it. */
  protected captureChildren(): readonly { release(): void }[] {
    const ground = this.resolved.ground;
    this.ground = ground;
    this.captured = ground?.capture();
    return this.captured ? [this.captured] : [];
  }

  protected async prepare(frame: kit.Preparation): Promise<Pending> {
    this.live();
    const { data, style, layout, limits } = this,
      captured = this.captured;
    // Edges joining the same two vertices read their lanes once they draw apart.
    const spaced = style.edgeSpacingPx > 0;
    const topology =
      this.geometry?.native ?? this.geometry ?? (await readGeometry(data, frame.reader, limits));
    // What the data draws: read, scaled, placed, and compiled once, until the data, its bindings,
    // the layout, or the coordinate of a sampled read change.
    const { geometry, reads } = await frame.memo(
      'reads',
      [
        topology,
        data.source,
        data.vertices,
        data.edges,
        layout,
        this.resolved.config.limits,
        spaced,
      ],
      async (f) => {
        let geometry = topology;
        const vertices = new Map<VertexBank, FieldRead>(),
          edges = new Map<EdgeBank, FieldRead>(),
          free = new Set(
            Object.keys(data.vertices).filter(
              (type) => placement(data.source, type, data.vertices[type]) === 'free',
            ),
          );
        // A type without x or y reads where layout places it, below.
        for (const bank of geometry.vertices)
          if (!free.has(bank.type))
            vertices.set(bank, await readFields(f, data.source, bank, data.vertices[bank.type]));
        for (const bank of geometry.edges)
          edges.set(
            bank,
            await readFields(
              f,
              data.source,
              bank,
              edgeOptions(data, bank),
              spaced ? topology.adjacency.laneValues(bank, data) : undefined,
            ),
          );
        await resolveDomains(f, data.source, vertices, (bank) =>
          vertexOptions(data, bank as VertexBank),
        );
        await resolveDomains(f, data.source, edges, (bank) => edgeOptions(data, bank as EdgeBank));
        // Each bank holding a vertex without a position reads every row's from layout instead,
        // scaled as its type's other banks are.
        const placed = await this.placement.prepare(
            topology,
            data,
            vertices,
            layout,
            new Work(f.signal, limits.layoutMs),
          ),
          laid = new Map<VertexBank, FieldRead>();
        for (const [bank, values] of placed) {
          const read = await readFields(f, data.source, bank, data.vertices[bank.type], values),
            before = vertices.get(bank);
          if (before) vertices.set(bank, read.scaled(before.scales));
          else laid.set(bank, read);
        }
        await resolveDomains(f, data.source, laid, (bank) =>
          vertexOptions(data, bank as VertexBank),
        );
        for (const [bank, read] of laid) vertices.set(bank, read);
        const compiled = this.routes.prepare(topology, { vertices, edges }, data, this.limits);
        geometry = compiled.geometry;
        for (const [bank, original] of compiled.origins) edges.set(bank, edges.get(original)!);
        // An edge's private bends and junctions carry their own positions and heights.
        const points = new Map<VertexBank, FieldRead>();
        for (const bank of geometry.vertices)
          if (bank.synthetic)
            points.set(bank, await readFields(f, data.source, bank, bank.synthetic));
        await resolveDomains(f, data.source, points, (bank) =>
          vertexOptions(data, bank as VertexBank),
        );
        for (const [bank, read] of points) vertices.set(bank, read);
        return { geometry, reads: { vertices, edges } satisfies Reads };
      },
    );
    const picking = this.picking.prepare(geometry, reads, this.limits.pickingBytes);
    let camera = await this.frameCamera(frame, (items, current, viewport) =>
      this.framing(geometry, picking, items, current, viewport),
    );
    const framed = camera;
    // The globe and the mercator plane need geographic positions; a plane draws flat.
    if (PROJECTIONS[camera.projection].geographic && !geometry.geographic)
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
    const projector = new Projector(camera, frame.viewport);
    const height =
      style.zScale *
      (camera.projection === 'globe'
        ? 0.08
        : Math.max(
            picking.bounds[2] - picking.bounds[0],
            picking.bounds[3] - picking.bounds[1],
            1e-6,
          ) * 0.15);
    this.live();
    frame.signal.throwIfAborted();
    // The first presented frame after an animated change eases from what was shown, as long as the
    // style's animation lasts; an export draws every value where it is going.
    const motion = !this.reducedMotion,
      { presented, timeMs } = frame;
    if (presented && this.transitionRequested) {
      this.transitionRequested = false;
      this.transition =
        this.shown && motion && style.animationMs > 0
          ? { start: timeMs, from: this.shown.picking, begun: false }
          : undefined;
    }
    const transition = presented ? this.transition : undefined;
    let rest = transition
      ? (1 - Math.min(1, Math.max(0, (timeMs - transition.start) / style.animationMs))) ** 3
      : 0;
    // The frame's records, and what a transition eases them from; one the GPU budget cannot hold
    // steps, as a diagram's does past its geometry budget.
    const records = this.painter.records(
      geometry,
      data,
      rest > 0 ? { start: !transition!.begun } : null,
      presented,
    );
    if (rest > 0 && !records.easing) rest = 0;
    if (presented && rest === 0) this.transition = undefined;
    const labels = await this.labels.prepare(
      frame,
      this.gpu,
      geometry,
      rest > 0 ? picking.easedFrom(transition!.from, rest, camera.projection === 'globe') : picking,
      data,
      projector,
      height,
      style,
    );
    const previous = this.shown;
    const moving =
      !!previous &&
      (!picking.samePositions(previous.picking) ||
        height !== previous.height ||
        Object.keys(data.vertices).some(
          (key) => data.vertices[key].z !== previous.data.vertices[key]?.z,
        ));
    const hover = this.hoverFrame(
      frame,
      (point, radius, { check }) =>
        picking.nearest(point, data, projector, height, style, radius, check),
      moving || rest > 0,
    );
    const painted = await this.painter.prepare(frame, {
      pipelines: await this.framePipelines(frame),
      shade: this.shadeFrame(frame),
      camera,
      projector,
      light: captured?.light ?? null,
      halo: captured?.fill ?? style.background,
      grounded: !!captured,
      options: style,
      data,
      geometry,
      reads,
      selection: this.selection,
      hover,
      height,
      labels,
      records,
      motion,
      transition: rest > 0 ? { rest, start: !transition!.begun } : null,
    });
    // The ground beneath: this frame's camera and scene block, and the pointer where the graph
    // found nothing.
    const ground = await captured?.prepare(frame, {
      camera,
      msaa: style.msaa,
      pointer: hover ? null : this.pointerPoint,
      scene: painted.scene,
    });
    try {
      this.live();
      frame.signal.throwIfAborted();
      return {
        geometry,
        picking,
        projector,
        height,
        data,
        options: style,
        paint: ground ? { ...painted, ground } : painted,
        begins: rest > 0 && !transition!.begun,
      };
    } catch (error) {
      ground?.discard();
      throw error;
    }
  }
  protected encode(frame: kit.Encoding, pending: Pending): void {
    this.live();
    this.painter.encode(frame, pending.paint);
  }
  protected discard(pending: Pending): void {
    pending.paint.ground?.discard();
  }
  protected submitted(frame: FrameInfo, pending: Pending): void {
    pending.paint.ground?.submitted();
    this.geometry = pending.geometry;
    if (pending.begins && this.transition) this.transition.begun = true;
    // An exported frame leaves what pick, locate, selection, and the orbit see.
    if (!frame.presented) return;
    this.shown = pending;
    this.orbitTime = pending.projector.camera.orbit ? frame.timeMs : undefined;
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
   * Build the shown frame's missing hit-test indexes in cooperative slices, behind the frames, once
   * its positions and camera hold still, or at once when a query needs them; new positions or
   * destroy abort the build.
   */
  private indexLater({ picking, projector, height, options }: Presented): void {
    const running = this.indexing,
      { camera } = projector;
    if (running && !running.done && running.picking.sameIndexes(picking)) {
      // A camera still moving holds the build off until it settles.
      if (!sameView(running.camera, camera)) running.touch();
      running.camera = camera;
      return;
    }
    running?.stop.abort();
    this.indexing = undefined;
    // Raised rows on a tilted camera or a globe are found by scanning, so no index would be asked.
    if (!picking.indexed(camera.projection, height) || !picking.indexable(options)) return;
    const stop = new AbortController(),
      { signal } = stop,
      { settled, now, touch } = settle(INDEX_SETTLE_MS, signal);
    const built = settled
      .then(() => {
        signal.throwIfAborted();
        // Behind the frames: no frame waits on an index building.
        return picking.indexLater(options, new Work(signal, Infinity, 8, 'background'));
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
    const task = { picking, stop, now, touch, camera, built, done: false };
    this.indexing = task;
  }
  /** A paused network stops building its indexes; its next presented frame starts again. */
  protected paused(): void {
    this.indexing?.stop.abort();
    this.indexing = undefined;
  }
  protected release(): void {
    this.indexing?.stop.abort();
    this.indexing = undefined;
    this.shown = undefined;
    this.geometry = undefined;
    this.follow(undefined);
    this.ground = undefined;
    this.painter.destroy();
  }
}

/** A type's wiring: its reference and list fields. */
function wiring(_: string, definition: TypeDefinition): readonly string[] {
  return Object.keys(definition.fields).filter((field) => {
    const type = definition.fields[field].type;
    return typeof type === 'object' && (type.kind === 'reference' || type.kind === 'list');
  });
}
