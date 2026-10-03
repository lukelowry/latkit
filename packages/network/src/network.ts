import {
  GpuError,
  kit,
  viewStyle,
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
import { sameIndex, type Data } from '@latkit/model';
import type { Camera, Projection } from './camera.js';
import { DEFAULT_CAMERA, checkCamera, fit, mixCamera, move, zoom } from './camera.js';
import {
  FIELD_OPTIONS,
  networkData,
  type EdgeOptions,
  type NetworkData,
  type NetworkItem,
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
import { DEFAULTS, resolveStyle, type NetworkStyle, type Style } from './options.js';
import { Picking, type PickGeometry } from './picking.js';
import { readFields, resolveDomains, type FieldRead } from './rendering/fields.js';
import { Labels } from './rendering/labels.js';
import { Paths } from './geometry/paths.js';
import { Painter, type Paint, type Reads } from './rendering/painter.js';
import { pipelines } from './rendering/pipelines.js';

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
  set(patch: kit.Patch<NetworkConfig, Records, Merged>, options?: SetOptions): void;
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
  readonly viewport: kit.Viewport;
  readonly height: number;
  readonly data: NetworkData;
  readonly options: Style;
}
interface Pending extends Presented {
  readonly paint: Paint;
}
interface Resolved {
  readonly config: NetworkConfig;
  readonly data: NetworkData;
  readonly limits: Required<Limits>;
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
const KEYS = new Set([
  'canvas',
  'at',
  'paused',
  'source',
  'vertices',
  'edges',
  'paths',
  'camera',
  'input',
  'shade',
  'limits',
  ...Object.keys(viewStyle),
  ...Object.keys(DEFAULTS),
]);
function resolve(config: NetworkConfig): Resolved {
  for (const key of Object.keys(config))
    if (!KEYS.has(key)) throw new GpuError('invalid-input', 'Unknown network option: ' + key);
  if (!config.source || !config.vertices)
    throw new GpuError('invalid-input', 'Invalid network data');
  const data = networkData(config);
  for (const [type, edge] of Object.entries(data.edges ?? {})) {
    if (
      edge.ends &&
      (edge.ends.length !== 2 ||
        !edge.ends.every((end) => typeof end === 'string') ||
        edge.ends[0] === edge.ends[1])
    )
      throw new GpuError('invalid-input', 'Edge ends must be two distinct fields: ' + type);
    if (edge.ends && edge.junction)
      throw new GpuError('invalid-input', 'A junction centers a net, which has no ends: ' + type);
    if (!edge.ends && edge.bends)
      throw new GpuError('invalid-input', 'Bends require ends: ' + type);
  }
  for (const path of Object.values(data.paths ?? {})) {
    if (
      !path.points ||
      (path.widthPx !== undefined && (!Number.isFinite(path.widthPx) || path.widthPx < 0))
    )
      throw new GpuError('invalid-input', 'Invalid path options');
    if (path.curve && !['linear', 'geodesic'].includes(path.curve))
      throw new GpuError('invalid-input', 'Invalid path curve');
  }
  for (const key of Object.keys(config.limits ?? {}))
    if (!(key in DEFAULT_LIMITS))
      throw new GpuError('invalid-input', 'Unknown network limit: ' + key);
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new GpuError('invalid-input', 'Invalid network limit');
  resolveStyle(config, viewStyle);
  return { config, data, limits };
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
    NetworkEvents,
    NetworkItem,
    NetworkItem,
    Camera,
    Records,
    Merged
  >
  implements Network
{
  private data: NetworkData;
  private style: Style;
  private limits: Required<Limits>;
  private resolved?: Resolved;
  private geometry?: Geometry;
  /** The latest drawn frame: what pick, locate, and selection see. */
  private shown?: Presented;
  private pendingFrame?: Pending;
  /** This frame's geometry while its camera is framed. */
  private preparing?: { readonly geometry: Geometry; readonly picking: PickGeometry };
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
  private shadeAnimating = false;
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
    hits: (point, signal) => this.hits(point, this.viewStyle.pickRadiusPx, { signal }),
    fail: (error) => this.fail(error),
    locate: (item) => this.locate(item),
    neighborhood: (item) => this.neighborhood(item),
    reveal: (item) => this.reveal(item),
    selection: () => this.selection,
    choose: (items) => this.choose(items),
  };
  constructor(gpu: Gpu, config: NetworkConfig) {
    super(gpu, config, {
      records: ['vertices', 'edges', 'paths'],
      merged: ['camera', 'input', 'limits'],
      fields: FIELD_OPTIONS,
      framed: ['projection', 'center', 'scale', 'pitch', 'bearing'],
    });
    const resolved = resolve(this.config);
    this.data = resolved.data;
    this.limits = resolved.limits;
    this.style = resolveStyle(this.config, this.viewStyle);
    this.painter = new Painter(gpu);
    this.start();
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
  protected framing(
    items: readonly NetworkItem[] | undefined,
    camera: Camera,
    viewport: kit.Viewport,
  ): Partial<Camera> | undefined {
    const prepared = this.preparing;
    if (!prepared) return undefined;
    const { geometry, picking } = prepared;
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
  protected zoomed(camera: Camera, factor: number, anchor: Point, viewport: kit.Viewport): Camera {
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
      throw new GpuError('conflict', 'Selection belongs to another source');
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
  protected compileShade(
    shade: Shade | null,
    format: GPUTextureFormat,
    msaa: 1 | 4,
  ): Promise<unknown> {
    return pipelines(this.gpu, format, msaa, shade?.wgsl ?? kit.defaultShade);
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

  protected check(config: NetworkConfig): void {
    super.check(config);
    this.resolved = resolve(config);
  }
  protected configure(previous: NetworkConfig, next: NetworkConfig): void {
    const resolved = this.resolved?.config === next ? this.resolved : resolve(next);
    this.resolved = undefined;
    const before = this.data;
    if (
      previous.source !== next.source ||
      previous.vertices !== next.vertices ||
      previous.edges !== next.edges ||
      previous.paths !== next.paths
    )
      this.data = resolved.data;
    if (
      rewired(before, this.data) ||
      Object.entries(resolved.limits).some(
        ([key, value]) => this.limits[key as keyof Limits] !== value,
      )
    ) {
      this.geometry = undefined;
      this.pruneSelection();
    }
    this.limits = resolved.limits;
    this.style = resolveStyle(next, this.viewStyle);
    this.invalidate();
  }
  protected get animating(): boolean {
    return super.animating || this.camera.orbit || this.shadeAnimating;
  }

  protected async prepare(frame: kit.Preparation): Promise<void> {
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
    this.preparing = { geometry, picking };
    let camera: Camera;
    try {
      camera = await this.frameCamera(frame);
    } finally {
      this.preparing = undefined;
    }
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
    const host = new Float32Array(64),
      shade = this.shade,
      pointer = this.pointerPoint;
    this.shadeAnimating =
      shade?.tick?.(host, { timeMs: frame.timeMs, pointerPx: pointer, viewport: frame.viewport }) ??
      false;
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
      camera,
      options: style,
      data,
      geometry,
      reads,
      selection: this.selection,
      hover,
      pointer,
      height,
      shade,
      host,
      labels,
      phases,
    });
    this.live();
    frame.signal.throwIfAborted();
    this.pendingFrame = {
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
  protected discard(): void {
    this.pendingFrame = undefined;
  }
  protected encode(frame: kit.Encoding): void {
    this.live();
    if (!this.pendingFrame) throw new GpuError('invalid-input', 'Network was not prepared');
    this.painter.encode(frame, this.pendingFrame.paint);
  }
  protected submitted(frame: kit.FrameInfo): void {
    const pending = this.pendingFrame;
    if (!pending) return;
    this.pendingFrame = undefined;
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
    this.pendingFrame = undefined;
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
