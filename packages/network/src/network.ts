import { sameIndex } from '@latkit/model';
import {
  GpuError,
  type Encoding,
  type FrameInfo,
  type Gpu,
  type Invalidation,
  type NativeFields,
  type Preparation,
  type Renderer,
  type Viewport,
} from '@latkit/gpu';
import type { Queryable, Update } from '@latkit/model';
import type { Camera, Projection } from './camera.js';
import { checkCamera, fit, initialCamera, mixCamera, move, zoom } from './camera.js';
import type { EdgeOptions, PathOptions, NetworkData, NetworkItem, VertexOptions } from './data.js';
import {
  DEFAULT_LIMITS,
  readGeometry,
  vertexOptions,
  edgeOptions,
  type EdgeBank,
  type Geometry,
  type Limits,
  type VertexBank,
} from './geometry/connectivity.js';
import { resolveOptions, type Options } from './options.js';
import { HOVER_EXHAUSTED, Picking, type PickGeometry } from './picking.js';
import { readFields, resolveDomains, type FieldRead } from './rendering/fields.js';
import { Labels } from './rendering/labels.js';
import { Paths } from './geometry/paths.js';
import { Painter, type Paint, type Reads } from './rendering/painter.js';
import { pipelines } from './rendering/pipelines.js';
import type { Shade } from '@latkit/gpu';
import { defaultShade } from '@latkit/gpu';

export interface NetworkEvents {
  readonly invalidate: Invalidation;
  readonly hover: NetworkItem | null;
  readonly select: NetworkItem | null;
  readonly contextmenu: import('@latkit/gpu').ContextMenu<NetworkItem>;
  readonly fit: boolean;
  readonly orbit: boolean;
}
export interface NetworkStats {
  readonly vertices: number;
  readonly edges: number;
  /** Logical stroke segments before adaptive GPU tessellation. */
  readonly segments: number;
  readonly geometryBytes: number;
  readonly pickingBytes: number;
  readonly drawCalls: number;
  readonly prepareMs: number;
  readonly frames: number;
  readonly hover: import('@latkit/gpu').HoverState;
  /** Hover search CPU time in the submitted frame; zero when skipped. */
  readonly hoverMs: number;
}
export interface Network extends Renderer {
  setData(data: NetworkData): void;
  setVertex(type: string, patch: Partial<Omit<VertexOptions, 'rows'>>): void;
  setEdge(type: string, patch: Partial<Omit<EdgeOptions, 'rows' | 'connectivity'>>): void;
  setPath(type: string, patch: Partial<Omit<PathOptions, 'rows' | 'source'>>): void;
  setOptions(options: Options): void;
  setShade(shade: Shade | null): Promise<void>;
  readonly projection: Projection;
  readonly projections: Readonly<Record<Projection, boolean>>;
  readonly orbiting: boolean;
  getCamera(): Camera | null;
  setCamera(camera: Partial<Camera>, options?: { readonly animate?: boolean }): boolean;
  fit(options?: { readonly items?: readonly NetworkItem[]; readonly animate?: boolean }): void;
  reveal(
    item: NetworkItem,
    options?: { readonly neighbors?: boolean; readonly animate?: boolean },
  ): void;
  panBy(dx: number, dy: number): void;
  rotateBy(dx: number, dy: number): void;
  zoomBy(factor: number, anchor?: readonly [number, number]): void;
  orbit(active: boolean): boolean;
  select(item: NetworkItem | null): void;
  setPointer(point: readonly [number, number] | null): void;
  hitTest(
    point: readonly [number, number],
    options?: { readonly radiusPx?: number },
  ): readonly NetworkItem[];
  locate(item: NetworkItem): readonly [number, number] | null;
  neighborhood(item: NetworkItem): readonly NetworkItem[];
  stats(): NetworkStats;
  on<K extends keyof NetworkEvents>(
    event: K,
    listener: (value: NetworkEvents[K]) => void,
  ): () => void;
}
export interface NetworkOptions {
  readonly gpu: Gpu;
  readonly data: NetworkData;
  readonly camera?: Partial<Camera>;
  readonly options?: Options;
  readonly limits?: Limits;
  readonly shade?: Shade;
}
interface Presented {
  readonly geometry: Geometry;
  readonly picking: PickGeometry;
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly height: number;
  readonly data: NetworkData;
  readonly options: Required<Options>;
  readonly release: () => void;
}
interface PreparedHover {
  readonly item: NetworkItem | null;
  readonly state: NetworkStats['hover'];
  readonly ms: number;
  readonly settleAt: number;
  readonly version: number;
  readonly pointerVersion: number;
}
interface Pending extends Presented {
  readonly hover: PreparedHover;
  readonly paint: Paint;
  readonly prepareMs: number;
  readonly finishedAnimation?: object;
  commit(): void;
}
function sameItem(a: NetworkItem | null, b: NetworkItem | null): boolean {
  return (
    a === b ||
    !!(
      a &&
      b &&
      a.source === b.source &&
      a.kind === b.kind &&
      a.row === b.row &&
      sameIndex(a.index, b.index)
    )
  );
}
function checkedData(data: NetworkData): NetworkData {
  if (!data.source || !['cartesian', 'geographic'].includes(data.coordinates) || !data.vertices)
    throw new GpuError('invalid-input', 'Invalid network data');
  for (const [type, edge] of Object.entries(data.edges ?? {})) {
    if (!edge.connectivity || !['links', 'endpoints'].includes(edge.connectivity.kind))
      throw new GpuError('invalid-input', 'Invalid connectivity for ' + type);
    if (edge.connectivity.kind === 'links' && !data.vertices[edge.connectivity.to])
      throw new GpuError('invalid-input', 'Link target must have a vertex declaration');
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
  return data;
}
const inputEvents = new WeakMap<
  Network,
  <K extends 'select' | 'contextmenu'>(event: K, value: NetworkEvents[K]) => void
>();
export function createNetwork(options: NetworkOptions): Network {
  return new NetworkView(options);
}
class NetworkView implements Network {
  private data: NetworkData;
  private options: Required<Options>;
  private readonly limits: Required<Limits>;
  private camera: Camera;
  private placed = false;
  private shade: Shade | null;
  private shadeSerial = 0;
  private geometry?: Geometry;
  private presented?: Presented;
  private pendingFrame?: Pending;
  private readonly painter: Painter;
  private readonly picking = new Picking();
  private readonly paths = new Paths();
  private readonly gpu: Gpu;
  private selected: NetworkItem | null = null;
  private hover: NetworkItem | null = null;
  private pointer: readonly [number, number] | null = null;
  private pointerVersion = 0;
  private hoverVersion = 0;
  private hoverSuspended = false;
  private hoverUntil = 0;
  private hoverWake?: ReturnType<typeof setTimeout>;
  private listeners = new Map<keyof NetworkEvents, Set<(payload: never) => void>>();
  private subscriptions: (() => void)[] = [];
  private closed = false;
  private spinning = false;
  private shadeAnimating = false;
  private previousTime?: number;
  private clock = 0;
  private animation?: { from: Camera; to: Camera; start: number; duration: number };
  private readonly labels = new Labels();
  private currentStats: NetworkStats = {
    vertices: 0,
    edges: 0,
    segments: 0,
    geometryBytes: 0,
    pickingBytes: 0,
    drawCalls: 0,
    prepareMs: 0,
    frames: 0,
    hover: 'idle',
    hoverMs: 0,
  };
  constructor(config: NetworkOptions) {
    this.gpu = config.gpu;
    this.data = checkedData(config.data);
    this.options = resolveOptions(config.options ?? {});
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new GpuError('invalid-input', 'Invalid network limit');
    this.camera = initialCamera({
      ...config.camera,
      fit:
        config.camera?.fit ??
        !(
          config.camera &&
          ('scale' in config.camera || 'centerX' in config.camera || 'centerY' in config.camera)
        ),
    });
    this.shade = config.shade ?? null;
    if (this.camera.projection === 'globe' && this.data.coordinates !== 'geographic')
      throw new GpuError('invalid-input', 'Globe requires geographic coordinates');
    this.painter = new Painter(this.gpu);
    this.subscribe();
    inputEvents.set(this, (event, value) => this.emit(event, value));
  }
  private live(): void {
    if (this.closed) throw new GpuError('closed', 'Network is destroyed');
  }
  private emit<K extends keyof NetworkEvents>(event: K, value: NetworkEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
  private invalidate(change: Invalidation = 'replace'): void {
    this.live();
    this.emit('invalidate', change);
  }
  on<K extends keyof NetworkEvents>(
    event: K,
    listener: (value: NetworkEvents[K]) => void,
  ): () => void {
    this.live();
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => set!.delete(listener as (payload: never) => void);
  }
  private subscribe(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    const sources = new Set<Queryable>([this.data.source]);
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('source' in value && 'field' in value) {
        sources.add((value as { source: Queryable }).source);
        return;
      }
      if (ArrayBuffer.isView(value) || 'values' in value) return;
      for (const child of Object.values(value as Record<string, unknown>)) visit(child);
    };
    visit(this.data.vertices);
    visit(this.data.edges);
    visit(this.data.paths);
    for (const path of Object.values(this.data.paths ?? {}))
      if (path.source) sources.add(path.source);
    for (const source of sources)
      this.subscriptions.push(
        source.on('change', (change: Update) => {
          if (this.closed) return;
          this.labels.invalidate(source, change);
          if (change.kind === 'replace') {
            this.geometry = undefined;
            this.selected = null;
            this.resetHover();
          }
          this.invalidate(
            change.kind === 'append' || change.kind === 'status' ? 'refresh' : 'replace',
          );
        }),
      );
  }
  setData(data: NetworkData): void {
    this.live();
    this.data = checkedData(data);
    this.geometry = undefined;
    this.placed = false;
    this.selected = null;
    this.resetHover();
    this.subscribe();
    this.invalidate();
  }
  setVertex(type: string, patch: Partial<Omit<VertexOptions, 'rows'>>): void {
    this.live();
    if (!this.data.vertices[type]) throw new GpuError('invalid-input', 'Unknown vertex type');
    this.data = {
      ...this.data,
      vertices: { ...this.data.vertices, [type]: { ...this.data.vertices[type], ...patch } },
    };
    if ('position' in patch || 'height' in patch) this.resetHover();
    this.subscribe();
    this.invalidate();
  }
  setEdge(type: string, patch: Partial<Omit<EdgeOptions, 'rows' | 'connectivity'>>): void {
    this.live();
    if (!this.data.edges?.[type]) throw new GpuError('invalid-input', 'Unknown edge type');
    this.data = {
      ...this.data,
      edges: { ...this.data.edges, [type]: { ...this.data.edges[type], ...patch } },
    };
    this.subscribe();
    this.invalidate();
  }
  setPath(type: string, patch: Partial<Omit<PathOptions, 'rows' | 'source'>>): void {
    this.live();
    if (!this.data.paths?.[type]) throw new GpuError('invalid-input', 'Unknown path type');
    this.data = checkedData({
      ...this.data,
      paths: { ...this.data.paths, [type]: { ...this.data.paths[type], ...patch } },
    });
    this.subscribe();
    this.resetHover();
    this.invalidate();
  }
  setOptions(patch: Options): void {
    this.live();
    this.options = resolveOptions(patch, this.options);
    if ('hover' in patch || 'hoverBudgetMs' in patch) this.resetHover();
    this.invalidate();
  }
  async setShade(shade: Shade | null): Promise<void> {
    this.live();
    const serial = ++this.shadeSerial;
    await Promise.all(
      (['rgba8unorm', 'bgra8unorm'] as const).map((format) =>
        pipelines(this.gpu, format, this.options.msaa, shade?.wgsl ?? defaultShade),
      ),
    );
    this.live();
    if (serial !== this.shadeSerial) return;
    this.shade = shade;
    this.invalidate();
  }
  get projection(): Projection {
    return this.camera.projection;
  }
  get projections(): Readonly<Record<Projection, boolean>> {
    return { flat: true, tilt: true, globe: this.data.coordinates === 'geographic' };
  }
  get orbiting(): boolean {
    return this.spinning;
  }
  get animating(): boolean {
    return this.spinning || !!this.animation || this.shadeAnimating;
  }
  getCamera(): Camera | null {
    return this.placed ? this.camera : null;
  }
  private reduced(): boolean {
    return (
      this.options.motion === 'reduce' ||
      (this.options.motion === 'auto' &&
        globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
    );
  }
  setCamera(patch: Partial<Camera>, options: { readonly animate?: boolean } = {}): boolean {
    this.live();
    if (patch.projection === 'globe' && !this.projections.globe) return false;
    const target = checkCamera({ ...this.camera, ...patch, fit: patch.fit ?? false });
    if (target.projection !== this.camera.projection) this.resetHover();
    if (
      options.animate &&
      !this.reduced() &&
      this.placed &&
      target.projection === this.camera.projection
    )
      this.animation = {
        from: this.camera,
        to: target,
        start: this.clock,
        duration: this.options.animationMs,
      };
    else {
      this.camera = target;
      this.animation = undefined;
    }
    this.invalidate();
    return true;
  }
  fit(options: { readonly items?: readonly NetworkItem[]; readonly animate?: boolean } = {}): void {
    this.live();
    if (!this.presented) {
      this.camera = { ...this.camera, fit: true };
      this.invalidate();
      return;
    }
    let bounds = this.presented.picking.bounds;
    if (options.items?.length) {
      const points = options.items.flatMap((item) => {
        if (item.kind !== 'vertex')
          return this.neighborhood(item).filter((n) => n.kind === 'vertex');
        return [item];
      });
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const item of points) {
        const found = this.geometry?.lookup
          .get(JSON.stringify([item.index.source, item.index.type, item.index.version]))
          ?.get(item.row);
        if (found) {
          const [x, y] = this.presented.picking.position(found.value, found.offset);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (minX <= maxX) bounds = [minX, minY, maxX, maxY];
    }
    this.setCamera(fit(bounds, this.presented.viewport, this.camera, this.options), options);
  }
  reveal(
    item: NetworkItem,
    options: { readonly neighbors?: boolean; readonly animate?: boolean } = {},
  ): void {
    if (options.neighbors) {
      this.fit({ items: this.neighborhood(item), animate: options.animate });
      return;
    }
    const point = this.locate(item),
      shown = this.presented;
    if (!point || !shown) return;
    const inset = this.options.revealPaddingPx;
    if (
      point[0] < inset ||
      point[0] > shown.viewport.width - inset ||
      point[1] < inset ||
      point[1] > shown.viewport.height - inset
    )
      this.setCamera(
        move(
          this.camera,
          shown.viewport.width / 2 - point[0],
          shown.viewport.height / 2 - point[1],
        ),
        options,
      );
  }
  panBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new RangeError('Invalid pan');
    this.orbit(false);
    this.setCamera(move(this.camera, dx, dy));
  }
  rotateBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new RangeError('Invalid rotation');
    this.orbit(false);
    this.setCamera({
      projection: this.camera.projection === 'flat' ? 'tilt' : this.camera.projection,
      bearing: this.camera.bearing + dx * 0.4,
      pitch: Math.max(0, Math.min(80, this.camera.pitch - dy * 0.25)),
    });
  }
  zoomBy(factor: number, anchor?: readonly [number, number]): void {
    if (!this.presented) return;
    const vp = this.presented.viewport;
    this.orbit(false);
    this.setCamera(zoom(this.camera, factor, anchor ?? [vp.width / 2, vp.height / 2], vp));
  }
  orbit(active: boolean): boolean {
    this.live();
    if (active && this.reduced()) return false;
    if (this.spinning === active) return false;
    this.spinning = active;
    this.previousTime = undefined;
    if (active && this.camera.projection === 'flat') {
      this.resetHover();
      this.camera = { ...this.camera, projection: 'tilt', pitch: 45 };
    }
    this.emit('orbit', active);
    this.invalidate('refresh');
    return true;
  }
  select(item: NetworkItem | null): void {
    this.live();
    if (
      item &&
      item.source !==
        (item.kind === 'path'
          ? (this.data.paths?.[item.index.type]?.source ?? this.data.source)
          : this.data.source)
    )
      throw new GpuError('conflict', 'Selection belongs to another source');
    this.selected = item;
    this.invalidate('refresh');
  }
  private clearHoverWake(): void {
    if (this.hoverWake !== undefined) clearTimeout(this.hoverWake);
    this.hoverWake = undefined;
  }
  private resetHover(): void {
    this.hoverVersion++;
    this.hoverSuspended = false;
    this.hoverUntil = 0;
    this.clearHoverWake();
  }
  private publishHover(item: NetworkItem | null): void {
    if (sameItem(item, this.hover)) return;
    this.hover = item;
    this.emit('hover', item);
  }
  setPointer(point: readonly [number, number] | null): void {
    this.live();
    if (point && !point.every(Number.isFinite)) throw new RangeError('Invalid pointer');
    const leaving = !point && this.pointer !== null;
    this.pointer = point;
    this.pointerVersion++;
    const hadHover = this.hover !== null;
    if (!point) {
      this.clearHoverWake();
      this.publishHover(null);
    }
    const eligible =
      this.options.hover === 'on' ||
      (this.options.hover === 'auto' &&
        !this.hoverSuspended &&
        performance.now() >= this.hoverUntil);
    if (
      point &&
      this.options.hover === 'auto' &&
      !this.hoverSuspended &&
      !eligible &&
      this.hoverWake === undefined
    )
      this.hoverWake = setTimeout(
        () => {
          this.hoverWake = undefined;
          if (!this.closed && this.pointer) this.invalidate('refresh');
        },
        Math.max(1, this.hoverUntil - performance.now()),
      );
    // Pointer events only request work; the shared frame scheduler coalesces searches.
    if (
      (point && eligible) ||
      hadHover ||
      (leaving && this.options.hover !== 'off' && !this.hoverSuspended) ||
      this.shade
    )
      this.invalidate('refresh');
  }
  private prepareHover(
    picking: PickGeometry,
    camera: Camera,
    viewport: Viewport,
    height: number,
  ): PreparedHover {
    const previous = this.presented;
    const moved =
      !!previous &&
      (!picking.samePositions(previous.picking) ||
        height !== previous.height ||
        viewport.width !== previous.viewport.width ||
        viewport.height !== previous.viewport.height ||
        (['centerX', 'centerY', 'scale', 'pitch', 'bearing', 'projection'] as const).some(
          (key) => camera[key] !== previous.camera[key],
        ) ||
        Object.keys(this.data.vertices).some(
          (key) => this.data.vertices[key].height !== previous.data.vertices[key]?.height,
        ));
    const settleAt =
      moved || this.spinning || this.animation ? performance.now() + 150 : this.hoverUntil;
    const base = { version: this.hoverVersion, pointerVersion: this.pointerVersion, settleAt };
    if (this.options.hover === 'off') return { ...base, item: null, state: 'off', ms: 0 };
    if (!this.pointer) return { ...base, item: null, state: 'idle', ms: 0 };
    if (this.options.hover === 'auto') {
      if (this.hoverSuspended) return { ...base, item: null, state: 'budget', ms: 0 };
      if (performance.now() < settleAt) return { ...base, item: null, state: 'moving', ms: 0 };
    }
    const started = performance.now();
    const item = picking.nearest(
      this.pointer,
      this.data,
      camera,
      viewport,
      height,
      this.options,
      this.options.pickRadiusPx,
      this.options.hover === 'auto' ? this.options.hoverBudgetMs : undefined,
    );
    return {
      ...base,
      item: item === HOVER_EXHAUSTED ? null : item,
      state: item === HOVER_EXHAUSTED ? 'budget' : 'active',
      ms: performance.now() - started,
    };
  }
  hitTest(
    point: readonly [number, number],
    options: { readonly radiusPx?: number } = {},
  ): readonly NetworkItem[] {
    const shown = this.presented;
    if (!shown) return [];
    const radius = options.radiusPx ?? this.options.pickRadiusPx;
    if (!point.every(Number.isFinite) || !Number.isFinite(radius) || radius < 0)
      throw new RangeError('Invalid hit query');
    return shown.picking.hit(
      point,
      shown.data,
      shown.camera,
      shown.viewport,
      shown.height,
      shown.options,
      Math.min(radius, Math.hypot(shown.viewport.width, shown.viewport.height)),
    );
  }
  locate(item: NetworkItem): readonly [number, number] | null {
    const p = this.presented;
    return p ? p.picking.locate(item, p.data, p.camera, p.viewport, p.height) : null;
  }
  neighborhood(item: NetworkItem): readonly NetworkItem[] {
    return this.presented?.geometry.adjacency.neighborhood(item, this.presented.data) ?? [];
  }
  stats(): NetworkStats {
    return {
      ...this.currentStats,
      pickingBytes: this.presented?.picking.bytes ?? 0,
      hover:
        this.options.hover === 'off'
          ? 'off'
          : this.hoverSuspended
            ? 'budget'
            : this.currentStats.hover,
    };
  }
  async prepare(frame: Preparation): Promise<void> {
    this.live();
    const started = performance.now();
    const releases: (() => void)[] = [],
      held = new Set<NativeFields>();
    let released = false,
      committed = false;
    const release = () => {
      if (!released) {
        released = true;
        for (const off of releases) off();
      }
    };
    const abort = () => {
      if (!committed) release();
    };
    frame.signal.addEventListener('abort', abort, { once: true });
    try {
      const topology =
        this.geometry?.native ??
        this.geometry ??
        (await readGeometry(this.data, frame, this.limits));
      let geometry = topology;
      const vertices = new Map<VertexBank, FieldRead>(),
        edges = new Map<import('./geometry/connectivity.js').EdgeBank, FieldRead>();
      const retain = (native: NativeFields) => {
        if (!held.has(native)) {
          held.add(native);
          releases.push(native.retain());
        }
      };
      for (const bank of geometry.vertices)
        vertices.set(
          bank,
          await readFields(
            frame,
            this.data.source,
            bank,
            this.data.vertices[bank.type],
            this.data.vertices[bank.type].position ?? bank.position,
            retain,
          ),
        );
      for (const bank of geometry.edges)
        edges.set(
          bank,
          await readFields(
            frame,
            bank.source ?? this.data.source,
            bank,
            edgeOptions(this.data, bank),
            undefined,
            retain,
          ),
        );
      await resolveDomains(frame, this.data.source, vertices, (bank) =>
        vertexOptions(this.data, bank as VertexBank),
      );
      await resolveDomains(frame, this.data.source, edges, (bank) =>
        edgeOptions(this.data, bank as EdgeBank),
      );
      const compiled = this.paths.prepare(topology, { vertices, edges }, this.data, this.limits);
      geometry = compiled.geometry;
      for (const [bank, original] of compiled.origins) edges.set(bank, edges.get(original)!);
      for (const bank of geometry.vertices)
        if (bank.synthetic)
          vertices.set(
            bank,
            await readFields(frame, this.data.source, bank, bank.synthetic, bank.position, retain),
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
        picking = this.picking.prepare(geometry, reads, this.limits.cpuBytes - geometry.bytes);
      if (geometry.bytes + picking.bytes > this.limits.cpuBytes)
        throw new GpuError('resource-limit', 'Network geometry and picking exceed the CPU budget');
      let camera = this.camera;
      if (camera.fit) camera = fit(picking.bounds, frame.viewport, camera, this.options);
      let finishedAnimation: object | undefined;
      if (this.animation) {
        const t = Math.max(
          0,
          Math.min(1, (frame.timeMs - this.animation.start) / Math.max(1, this.animation.duration)),
        );
        camera = mixCamera(this.animation.from, this.animation.to, t * t * (3 - 2 * t));
        if (t === 1) finishedAnimation = this.animation;
      }
      if (this.spinning && this.previousTime !== undefined) {
        const dt = Math.max(0, Math.min(100, frame.timeMs - this.previousTime));
        camera = {
          ...camera,
          fit: false,
          bearing: camera.bearing + dt * 0.012 * this.options.orbitRate,
        };
      }
      const height =
        this.options.heightScale *
        (camera.projection === 'globe'
          ? 0.08
          : Math.max(
              picking.bounds[2] - picking.bounds[0],
              picking.bounds[3] - picking.bounds[1],
              1e-6,
            ) * 0.15);
      const host = new Float32Array(64);
      this.shadeAnimating =
        this.shade?.tick?.(host, {
          timeMs: frame.timeMs,
          pointerPx: this.pointer,
          viewport: frame.viewport,
        }) ?? false;
      this.live();
      frame.signal.throwIfAborted();
      const phases = picking.dashPhases(this.data, camera, frame.viewport, height);
      const labels = await this.labels.prepare(
        frame,
        this.gpu,
        geometry,
        picking,
        this.data,
        camera,
        height,
        this.options,
      );
      const hover = this.prepareHover(picking, camera, frame.viewport, height);
      const paint = await this.painter.prepare(frame, {
        camera,
        options: this.options,
        data: this.data,
        geometry,
        reads,
        selected: this.selected,
        hover: hover.item,
        pointer: this.pointer,
        height,
        shade: this.shade,
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
        data: this.data,
        options: this.options,
        paint,
        hover,
        prepareMs: performance.now() - started,
        finishedAnimation,
        release,
        commit: () => {
          committed = true;
          frame.signal.removeEventListener('abort', abort);
        },
      };
    } catch (error) {
      frame.signal.removeEventListener('abort', abort);
      release();
      throw error;
    }
  }
  encode(frame: Encoding): void {
    this.live();
    if (!this.pendingFrame) throw new GpuError('invalid-input', 'Network was not prepared');
    this.painter.encode(frame, this.pendingFrame.paint);
  }
  submitted(frame: FrameInfo): void {
    const pending = this.pendingFrame;
    if (!pending || this.closed) return;
    pending.commit();
    if (this.animation === pending.finishedAnimation) this.animation = undefined;
    this.presented?.release();
    this.presented = pending;
    this.pendingFrame = undefined;
    const before = this.camera.fit;
    this.camera = pending.camera;
    this.placed = true;
    this.geometry = pending.geometry;
    this.previousTime = frame.timeMs;
    this.clock = frame.timeMs;
    this.painter.prune(pending.geometry);
    this.currentStats = {
      vertices: pending.geometry.vertexCount,
      edges: pending.geometry.edgeCount,
      segments: pending.geometry.segmentCount,
      geometryBytes: pending.geometry.bytes,
      pickingBytes: pending.picking.bytes,
      drawCalls: pending.paint.drawCalls,
      prepareMs: pending.prepareMs,
      frames: this.currentStats.frames + 1,
      hover: pending.hover.state,
      hoverMs: pending.hover.ms,
    };
    const hover = pending.hover;
    if (hover.version === this.hoverVersion) {
      this.hoverSuspended ||= hover.state === 'budget';
      this.hoverUntil = hover.settleAt;
      this.clearHoverWake();
      if (
        this.pointer &&
        this.options.hover === 'auto' &&
        !this.hoverSuspended &&
        performance.now() < hover.settleAt
      )
        this.hoverWake = setTimeout(
          () => {
            this.hoverWake = undefined;
            if (!this.closed && this.pointer) this.invalidate('refresh');
          },
          Math.max(1, hover.settleAt - performance.now()),
        );
      if (hover.pointerVersion === this.pointerVersion) this.publishHover(hover.item);
    }
    if (!this.closed && before !== this.camera.fit) this.emit('fit', this.camera.fit);
  }
  destroy(): void {
    if (this.closed) return;
    this.emit('invalidate', 'replace');
    this.closed = true;
    this.clearHoverWake();
    this.shadeSerial++;
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    this.listeners.clear();
    inputEvents.delete(this);
    this.pendingFrame?.release();
    this.presented?.release();
    this.pendingFrame = undefined;
    this.presented = undefined;
    this.geometry = undefined;
    this.painter.destroy();
  }
}
/** Input attachments report user actions through the renderer's existing event stream. */
export function notifyInput<K extends 'select' | 'contextmenu'>(
  network: Network,
  event: K,
  value: NetworkEvents[K],
): void {
  inputEvents.get(network)?.(event, value);
}
