import { GpuError, kit, type Gpu, type Shade, type View } from '@latkit/gpu';
import type { Queryable, Update } from '@latkit/model';
import type { Camera, Projection } from './camera.js';
import { DEFAULT_CAMERA, checkCamera, fit, mixCamera, move, zoom } from './camera.js';
import {
  networkData,
  sameItem,
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
import { attachInput, type NetworkInput } from './input.js';
import { DEFAULTS, resolveStyle, type Style, type StyleOptions } from './options.js';
import { HOVER_EXHAUSTED, Picking, type PickGeometry } from './picking.js';
import { readFields, resolveDomains, type FieldRead } from './rendering/fields.js';
import { Labels } from './rendering/labels.js';
import { Paths } from './geometry/paths.js';
import { Painter, type Paint, type Reads } from './rendering/painter.js';
import { pipelines } from './rendering/pipelines.js';

type Point = readonly [number, number];
export interface NetworkConfig extends kit.ViewConfig, StyleOptions {
  /** Borrowed: destroy never closes it. */
  readonly source: Queryable;
  /** Drawn types by model type name. */
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly paths?: Readonly<Record<string, PathOptions>>;
  /** Where the camera starts; `network.camera` is where it is. Fits the data by default. */
  readonly camera?: Partial<Camera>;
  /** Pointer and keyboard control of the canvas; `navigate` by default. */
  readonly input?: NonNullable<NetworkInput['mode']> | NetworkInput;
  /** WGSL that recolors every fragment. */
  readonly shade?: Shade | null;
  readonly limits?: Limits;
}
export interface NetworkEvents extends kit.ViewEvents {
  /** The item under the pointer. */
  readonly hover: NetworkItem | null;
  /** The user changed the selection. */
  readonly select: readonly NetworkItem[];
  readonly contextmenu: kit.ContextMenu<NetworkItem>;
  /** The presented camera changed. */
  readonly camera: Camera;
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
  readonly hover: kit.HoverState;
  /** Hover search CPU time in the submitted frame; zero when skipped. */
  readonly hoverMs: number;
}
type Records = 'vertices' | 'edges' | 'paths';
type Merged = 'camera' | 'input' | 'limits';
export interface Network extends View<NetworkConfig, NetworkEvents> {
  set(
    patch: kit.Patch<NetworkConfig, 'vertices' | 'edges' | 'paths', 'camera' | 'input' | 'limits'>,
    options?: kit.SetOptions,
  ): void;
  /** Where the camera is. `set({ camera })` moves it. */
  readonly camera: Camera;
  /** Projections the data supports: the globe needs geographic positions. */
  readonly projections: Readonly<Record<Projection, boolean>>;
  readonly selection: readonly NetworkItem[];
  select(items: readonly NetworkItem[]): void;
  /** Items near a canvas point, nearest first. */
  pick(
    point: readonly [x: number, y: number],
    options?: { readonly radiusPx?: number },
  ): Promise<readonly NetworkItem[]>;
  /** An item's canvas point, or null when it is not drawn. */
  locate(item: NetworkItem): readonly [x: number, y: number] | null;
  /** The item, the edges at a vertex or the vertices of an edge, and itself. */
  neighborhood(item: NetworkItem): readonly NetworkItem[];
  /** Frame the items, or follow all the data. */
  fit(items?: readonly NetworkItem[], options?: kit.SetOptions): void;
  /** Pan just enough to show the item. */
  reveal(item: NetworkItem, options?: kit.SetOptions): void;
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
interface Resolved {
  readonly config: NetworkConfig;
  readonly data: NetworkData;
  readonly style: Style;
  readonly limits: Required<Limits>;
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
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new GpuError('invalid-input', 'Invalid network limit');
  return { config, data, style: resolveStyle(config), limits };
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
    a.source !== b.source ||
    differ(a.vertices, b.vertices, ['rows']) ||
    differ(a.edges, b.edges, ['rows', 'ends', 'junction']) ||
    differ(a.paths, b.paths, ['rows', 'source'])
  );
}

class NetworkView extends kit.BaseView<NetworkConfig, NetworkEvents, Records, Merged> {
  private data: NetworkData;
  private style: Style;
  private limits: Required<Limits>;
  private resolved?: Resolved;
  private view: Camera;
  private placed = false;
  private shade: Shade | null;
  private shadeSerial = 0;
  private geometry?: Geometry;
  private presented?: Presented;
  private pendingFrame?: Pending;
  private reported?: Camera;
  private readonly painter: Painter;
  private readonly picking = new Picking();
  private readonly paths = new Paths();
  private chosen: readonly NetworkItem[] = Object.freeze([]);
  private chosenVersion = 0;
  private hover: NetworkItem | null = null;
  private pointer: Point | null = null;
  private pointerVersion = 0;
  private hoverVersion = 0;
  private hoverSuspended = false;
  private hoverUntil = 0;
  private hoverWake?: ReturnType<typeof setTimeout>;
  private subscriptions: (() => void)[] = [];
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
  constructor(gpu: Gpu, config: NetworkConfig) {
    super(gpu, config, {
      records: ['vertices', 'edges', 'paths'],
      merged: ['camera', 'input', 'limits'],
    });
    const resolved = resolve(this.config);
    this.data = resolved.data;
    this.style = resolved.style;
    this.limits = resolved.limits;
    const camera = config.camera ?? {};
    this.view = checkCamera({
      ...DEFAULT_CAMERA,
      ...camera,
      fit: camera.fit ?? !('center' in camera || 'scale' in camera),
      orbit: !!camera.orbit && !this.reduced(),
    });
    if (this.view.orbit && this.view.projection === 'flat')
      this.view = checkCamera({ ...this.view, projection: 'tilt', pitch: 45 });
    this.shade = config.shade ?? null;
    this.painter = new Painter(gpu);
    this.subscribe();
    this.start();
  }

  get camera(): Camera {
    return this.view;
  }
  /** Globe needs geographic positions, which the model's spatial system declares once read. */
  get projections(): Readonly<Record<Projection, boolean>> {
    return { flat: true, tilt: true, globe: this.presented?.geometry.geographic ?? false };
  }
  get selection(): readonly NetworkItem[] {
    return this.chosen;
  }
  select(items: readonly NetworkItem[]): void {
    this.live();
    for (const item of items)
      if (
        item.source !==
        (item.kind === 'path'
          ? (this.data.paths?.[item.index.type]?.source ?? this.data.source)
          : this.data.source)
      )
        throw new GpuError('conflict', 'Selection belongs to another source');
    this.chosen = Object.freeze([...items]);
    this.chosenVersion++;
    this.invalidate('refresh');
  }
  pick(
    point: Point,
    options: { readonly radiusPx?: number } = {},
  ): Promise<readonly NetworkItem[]> {
    return new Promise((resolve) => {
      this.live();
      resolve(this.hit(point, options.radiusPx));
    });
  }
  locate(item: NetworkItem): Point | null {
    const p = this.presented;
    return p ? p.picking.locate(item, p.data, p.camera, p.viewport, p.height) : null;
  }
  neighborhood(item: NetworkItem): readonly NetworkItem[] {
    return this.presented?.geometry.adjacency.neighborhood(item, this.presented.data) ?? [];
  }
  fit(items?: readonly NetworkItem[], options: kit.SetOptions = {}): void {
    this.live();
    const shown = this.presented;
    if (!shown) {
      this.moveCamera({ fit: !items?.length }, options);
      return;
    }
    let bounds = shown.picking.bounds;
    if (items?.length) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const item of items.flatMap((item) =>
        item.kind === 'vertex'
          ? [item]
          : this.neighborhood(item).filter((n) => n.kind === 'vertex'),
      )) {
        const found = shown.geometry.lookup.get(indexKey(item.index))?.get(item.row);
        if (found) {
          const [x, y] = shown.picking.position(found.value, found.offset);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (minX <= maxX) bounds = [minX, minY, maxX, maxY];
    }
    const framed = fit(bounds, shown.viewport, this.view, this.style);
    this.moveCamera({ ...framed, fit: !items?.length }, options);
  }
  reveal(item: NetworkItem, options: kit.SetOptions = {}): void {
    this.live();
    const point = this.locate(item),
      shown = this.presented;
    if (!point || !shown) return;
    const inset = this.style.revealPaddingPx;
    if (
      point[0] < inset ||
      point[0] > shown.viewport.width - inset ||
      point[1] < inset ||
      point[1] > shown.viewport.height - inset
    ) {
      const { center } = move(
        this.view,
        shown.viewport.width / 2 - point[0],
        shown.viewport.height / 2 - point[1],
      );
      this.moveCamera({ center }, options);
    }
  }
  stats(): NetworkStats {
    return {
      ...this.currentStats,
      pickingBytes: this.presented?.picking.bytes ?? 0,
      hover:
        this.style.hover === 'off'
          ? 'off'
          : this.hoverSuspended
            ? 'budget'
            : this.currentStats.hover,
    };
  }

  protected check(config: NetworkConfig): void {
    this.resolved = resolve(config);
  }
  protected configure(previous: NetworkConfig, next: NetworkConfig): void {
    const resolved = this.resolved?.config === next ? this.resolved : resolve(next);
    this.resolved = undefined;
    const before = this.data,
      bound =
        previous.source !== next.source ||
        previous.vertices !== next.vertices ||
        previous.edges !== next.edges ||
        previous.paths !== next.paths;
    if (bound) this.data = resolved.data;
    if (
      rewired(before, this.data) ||
      Object.entries(resolved.limits).some(
        ([key, value]) => this.limits[key as keyof Limits] !== value,
      )
    ) {
      this.geometry = undefined;
      this.placed = previous.source === next.source && this.placed;
      if (previous.source !== next.source) this.clearSelection();
    }
    this.limits = resolved.limits;
    const style = this.style;
    this.style = resolved.style;
    if (
      before !== this.data ||
      style.hover !== this.style.hover ||
      style.hoverBudgetMs !== this.style.hoverBudgetMs
    )
      this.resetHover();
    if (bound) this.subscribe();
    if (previous.shade !== next.shade) this.compile(next.shade ?? null);
    this.invalidate();
  }
  /** Null resets the camera to fit the data. */
  protected moveCamera(patch: Partial<Camera> | null, options: kit.SetOptions): void {
    const given = (
      patch === null
        ? DEFAULT_CAMERA
        : Object.fromEntries(
            Object.entries(patch).map(([key, value]) => [
              key,
              value ?? DEFAULT_CAMERA[key as keyof Camera],
            ]),
          )
    ) as Partial<Camera>;
    const moved = ['projection', 'center', 'scale', 'pitch', 'bearing'].some((key) => key in given);
    let target = checkCamera({
      ...this.view,
      ...given,
      fit: given.fit ?? (moved ? false : this.view.fit),
      orbit: (given.orbit ?? this.view.orbit) && !this.reduced(),
    });
    if (target.orbit && !this.view.orbit) {
      this.previousTime = undefined;
      if (target.projection === 'flat')
        target = checkCamera({ ...target, projection: 'tilt', pitch: 45 });
    }
    if (target.projection !== this.view.projection) this.resetHover();
    if (
      options.animate &&
      !this.reduced() &&
      this.placed &&
      target.projection === this.view.projection
    )
      this.animation = {
        from: this.view,
        to: target,
        start: this.clock,
        duration: this.style.animationMs,
      };
    else {
      this.view = target;
      this.animation = undefined;
    }
    this.invalidate(target.orbit ? 'refresh' : 'replace');
  }
  protected attach(canvas: HTMLCanvasElement): () => void {
    return attachInput(canvas, (this.config.input ?? {}) as NetworkInput, {
      pointer: (point) => this.point(point),
      pan: (dx, dy) => this.moveCamera({ ...move(this.view, dx, dy), orbit: false }, {}),
      rotate: (dx, dy) =>
        this.moveCamera(
          {
            projection: this.view.projection === 'flat' ? 'tilt' : this.view.projection,
            bearing: this.view.bearing + dx * 0.4,
            pitch: Math.max(0, Math.min(80, this.view.pitch - dy * 0.25)),
            orbit: false,
          },
          {},
        ),
      zoom: (factor, anchor) => {
        const vp = this.presented?.viewport;
        if (vp)
          this.moveCamera(
            {
              ...zoom(this.view, factor, anchor ?? [vp.width / 2, vp.height / 2], vp),
              orbit: false,
            },
            {},
          );
      },
      fit: () => this.fit(undefined, { animate: true }),
      hit: (point) => this.hit(point),
      locate: (item) => this.locate(item),
      neighborhood: (item) => this.neighborhood(item),
      reveal: (item) => this.reveal(item),
      selection: () => this.chosen,
      choose: (items) => {
        this.select(items);
        this.emit('select', this.chosen);
      },
      menu: (menu) => this.emit('contextmenu', menu),
    });
  }

  private reduced(): boolean {
    const motion = this.style?.motion ?? DEFAULTS.motion;
    return (
      motion === 'reduce' ||
      (motion === 'auto' &&
        globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
    );
  }
  private clearSelection(): void {
    if (!this.chosen.length) return;
    this.chosen = Object.freeze([]);
    this.chosenVersion++;
    this.emit('select', this.chosen);
  }
  private compile(shade: Shade | null): void {
    const serial = ++this.shadeSerial;
    Promise.all(
      (['rgba8unorm', 'bgra8unorm'] as const).map((format) =>
        pipelines(this.gpu, format, this.style.msaa, shade?.wgsl ?? kit.defaultShade),
      ),
    ).then(
      () => {
        if (serial !== this.shadeSerial) return;
        this.shade = shade;
        this.invalidate();
      },
      (error: unknown) => {
        if (serial === this.shadeSerial) this.fail(error);
      },
    );
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
          this.labels.invalidate(source, change);
          if (change.kind === 'replace') {
            this.geometry = undefined;
            this.clearSelection();
            this.resetHover();
          }
          this.invalidate(
            change.kind === 'append' || change.kind === 'status' ? 'refresh' : 'replace',
          );
        }),
      );
  }
  private hit(point: Point, radiusPx?: number): readonly NetworkItem[] {
    const shown = this.presented;
    if (!shown) return [];
    const radius = radiusPx ?? this.style.pickRadiusPx;
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
  private clearHoverWake(): void {
    if (this.hoverWake !== undefined) clearTimeout(this.hoverWake);
    this.hoverWake = undefined;
  }
  private wakeHover(at: number): void {
    this.hoverWake = setTimeout(
      () => {
        this.hoverWake = undefined;
        if (this.pointer) this.invalidate('refresh');
      },
      Math.max(1, at - performance.now()),
    );
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
  /** Move the pointer; frames search for hover, so pointer events only request work. */
  private point(point: Point | null): void {
    if (point && !point.every(Number.isFinite)) throw new RangeError('Invalid pointer');
    const leaving = !point && this.pointer !== null;
    this.pointer = point;
    this.pointerVersion++;
    const hadHover = this.hover !== null;
    if (!point) {
      this.clearHoverWake();
      this.publishHover(null);
    }
    const policy = this.style.hover;
    const eligible =
      policy === 'on' ||
      (policy === 'auto' && !this.hoverSuspended && performance.now() >= this.hoverUntil);
    if (
      point &&
      policy === 'auto' &&
      !this.hoverSuspended &&
      !eligible &&
      this.hoverWake === undefined
    )
      this.wakeHover(this.hoverUntil);
    if (
      (point && eligible) ||
      hadHover ||
      (leaving && policy !== 'off' && !this.hoverSuspended) ||
      this.shade
    )
      this.invalidate('refresh');
  }
  private prepareHover(
    picking: PickGeometry,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
  ): PreparedHover {
    const previous = this.presented;
    const moved =
      !!previous &&
      (!picking.samePositions(previous.picking) ||
        height !== previous.height ||
        viewport.width !== previous.viewport.width ||
        viewport.height !== previous.viewport.height ||
        camera.center[0] !== previous.camera.center[0] ||
        camera.center[1] !== previous.camera.center[1] ||
        (['scale', 'pitch', 'bearing', 'projection'] as const).some(
          (key) => camera[key] !== previous.camera[key],
        ) ||
        Object.keys(this.data.vertices).some(
          (key) => this.data.vertices[key].height !== previous.data.vertices[key]?.height,
        ));
    const settleAt =
      moved || camera.orbit || this.animation ? performance.now() + 150 : this.hoverUntil;
    const base = { version: this.hoverVersion, pointerVersion: this.pointerVersion, settleAt };
    if (this.style.hover === 'off') return { ...base, item: null, state: 'off', ms: 0 };
    if (!this.pointer) return { ...base, item: null, state: 'idle', ms: 0 };
    if (this.style.hover === 'auto') {
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
      this.style,
      this.style.pickRadiusPx,
      this.style.hover === 'auto' ? this.style.hoverBudgetMs : undefined,
    );
    return {
      ...base,
      item: item === HOVER_EXHAUSTED ? null : item,
      state: item === HOVER_EXHAUSTED ? 'budget' : 'active',
      ms: performance.now() - started,
    };
  }

  protected get animating(): boolean {
    return this.view.orbit || !!this.animation || this.shadeAnimating;
  }
  protected async prepare(frame: kit.Preparation): Promise<void> {
    this.live();
    const started = performance.now();
    const releases: (() => void)[] = [],
      held = new Set<kit.NativeFields>();
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
      const data = this.data,
        style = this.style;
      const topology =
        this.geometry?.native ?? this.geometry ?? (await readGeometry(data, frame, this.limits));
      let geometry = topology;
      const vertices = new Map<VertexBank, FieldRead>(),
        edges = new Map<EdgeBank, FieldRead>();
      const retain = (native: kit.NativeFields) => {
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
            data.source,
            bank,
            data.vertices[bank.type],
            data.vertices[bank.type].position ?? bank.position,
            retain,
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
            retain,
          ),
        );
      await resolveDomains(frame, data.source, vertices, (bank) =>
        vertexOptions(data, bank as VertexBank),
      );
      await resolveDomains(frame, data.source, edges, (bank) =>
        edgeOptions(data, bank as EdgeBank),
      );
      const compiled = this.paths.prepare(topology, { vertices, edges }, data, this.limits);
      geometry = compiled.geometry;
      for (const [bank, original] of compiled.origins) edges.set(bank, edges.get(original)!);
      for (const bank of geometry.vertices)
        if (bank.synthetic)
          vertices.set(
            bank,
            await readFields(frame, data.source, bank, bank.synthetic, bank.position, retain),
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
      let camera = this.view;
      if (camera.projection === 'globe' && !geometry.geographic)
        camera = { ...camera, projection: 'flat', pitch: 0 };
      if (camera.fit) camera = fit(picking.bounds, frame.viewport, camera, style);
      let finishedAnimation: object | undefined;
      if (this.animation) {
        const t = Math.max(
          0,
          Math.min(1, (frame.timeMs - this.animation.start) / Math.max(1, this.animation.duration)),
        );
        camera = mixCamera(this.animation.from, this.animation.to, t * t * (3 - 2 * t));
        if (t === 1) finishedAnimation = this.animation;
      }
      if (camera.orbit && this.previousTime !== undefined) {
        const dt = Math.max(0, Math.min(100, frame.timeMs - this.previousTime));
        camera = { ...camera, fit: false, bearing: camera.bearing + dt * 0.012 * style.orbitRate };
      }
      const height =
        style.heightScale *
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
      const hover = this.prepareHover(picking, camera, frame.viewport, height);
      const paint = await this.painter.prepare(frame, {
        camera,
        options: style,
        data,
        geometry,
        reads,
        selection: this.chosen,
        selectionVersion: this.chosenVersion,
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
        data,
        options: style,
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
  protected encode(frame: kit.Encoding): void {
    this.live();
    if (!this.pendingFrame) throw new GpuError('invalid-input', 'Network was not prepared');
    this.painter.encode(frame, this.pendingFrame.paint);
  }
  protected submitted(frame: kit.FrameInfo): void {
    const pending = this.pendingFrame;
    if (!pending) return;
    pending.commit();
    if (this.animation === pending.finishedAnimation) this.animation = undefined;
    this.presented?.release();
    this.presented = pending;
    this.pendingFrame = undefined;
    this.view = pending.camera;
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
        this.style.hover === 'auto' &&
        !this.hoverSuspended &&
        performance.now() < hover.settleAt
      )
        this.wakeHover(hover.settleAt);
      if (hover.pointerVersion === this.pointerVersion) this.publishHover(hover.item);
    }
    const camera = this.view,
      reported = this.reported;
    if (
      !reported ||
      camera.center[0] !== reported.center[0] ||
      camera.center[1] !== reported.center[1] ||
      (['projection', 'scale', 'pitch', 'bearing', 'fit', 'orbit'] as const).some(
        (key) => camera[key] !== reported[key],
      )
    ) {
      this.reported = camera;
      this.emit('camera', camera);
    }
  }
  protected release(): void {
    this.clearHoverWake();
    this.shadeSerial++;
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    this.pendingFrame?.release();
    this.presented?.release();
    this.pendingFrame = undefined;
    this.presented = undefined;
    this.geometry = undefined;
    this.painter.destroy();
  }
}
