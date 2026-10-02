import { GpuError, kit, type Gpu, type Shade, type View } from '@latkit/gpu';
import type { Data } from '@latkit/model';
import type {
  VertexOptions,
  EdgeOptions,
  DiagramData,
  DiagramItem,
  DiagramHit,
  Point,
  RowRef,
  Group,
} from './data.js';
import { diagramData, itemKey } from './data.js';
import type { Limits, StyleOptions } from './options.js';
import {
  data as checkedData,
  defaults,
  options as checkedOptions,
  limits as checkedLimits,
  positive,
  fail,
  type Style,
} from './config.js';
import { place, layoutOptions, type Layout, type LayoutOptions } from './layout.js';
import { readScene } from './read.js';
import { geometry } from './geometry.js';
import { positions, type Scene, type Rect } from './scene.js';
import { Picking } from './picking.js';
import { Work } from './work.js';
import { union } from './spatial.js';
import { Painter, type Paint, type Overlay } from './painter.js';
import { attachInput, type Controls, type DiagramInput } from './input.js';
/** A wiring the user drew; the application decides which references change. */
export interface ConnectProposal {
  /** Where the wiring starts: a vertex, or one of its ports. */
  readonly from: RowRef & { readonly port?: string };
  /** What it was dropped on: a vertex or its port, a net to join, or empty canvas. */
  readonly to: (RowRef & { readonly kind: 'vertex' | 'edge'; readonly port?: string }) | null;
  /** Dragging a wired input moves it: the net it leaves, and the port leaving it. */
  readonly replaces?: { readonly edge: RowRef; readonly end: RowRef & { readonly port: string } };
  readonly position: Point;
  readonly point: Point;
}
/** Vertices the user dragged; write the positions to the model to accept them. */
export interface MoveProposal {
  /** Moved positions by vertex type. */
  readonly positions: Readonly<Record<string, kit.FieldValues>>;
  readonly moves: readonly { readonly vertex: RowRef; readonly position: Point }[];
}
export interface Camera {
  /** Diagram units at the canvas center. */
  readonly center: Point;
  /** Pixels per diagram unit. */
  readonly scale: number;
  /** Keep the whole diagram in view as it changes. */
  readonly fit: boolean;
}
export interface DiagramConfig extends kit.ViewConfig, StyleOptions {
  /** Borrowed: destroy never closes it. */
  readonly source: Data;
  /** Drawn types by model type name. */
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly groups?: Readonly<Record<string, Group>>;
  /** How vertices are placed; `layered` by default, `manual` keeps model positions. */
  readonly layout?: Layout;
  /** Where the camera starts; `diagram.camera` is where it is. Fits the diagram by default. */
  readonly camera?: Partial<Camera>;
  /** Pointer and keyboard control of the canvas; `navigate` by default. */
  readonly input?: NonNullable<DiagramInput['mode']> | DiagramInput;
  /** WGSL that recolors every fragment. */
  readonly shade?: Shade | null;
  readonly limits?: Limits;
}
export interface DiagramEvents extends kit.ViewEvents {
  readonly hover: DiagramHit | null;
  /** The selection changed, by the user or because selected rows left the diagram. */
  readonly select: readonly DiagramItem[];
  readonly contextmenu: kit.ContextMenu<DiagramHit>;
  /** Double click or Enter. */
  readonly open: DiagramItem;
  readonly connect: ConnectProposal;
  readonly move: MoveProposal;
  /** Delete or Backspace in edit mode: the selected rows' ids. */
  readonly delete: readonly string[];
  /** The presented camera changed. */
  readonly camera: Camera;
}
export interface DiagramStats {
  readonly vertices: number;
  readonly edges: number;
  readonly ends: number;
  readonly geometryBytes: number;
  readonly pickingBytes: number;
  readonly prepareMs: number;
  readonly drawCalls: number;
  readonly frames: number;
  readonly hover: kit.HoverState;
}
type Records = 'vertices' | 'edges' | 'groups';
type Merged = 'camera' | 'input' | 'limits' | 'layout';
export interface Diagram extends View<DiagramConfig, DiagramEvents> {
  /** `animate` eases vertices to new positions and the camera to a new place. */
  set(
    patch: kit.Patch<
      DiagramConfig,
      'vertices' | 'edges' | 'groups',
      'camera' | 'input' | 'limits' | 'layout'
    >,
    options?: kit.SetOptions,
  ): void;
  /** Where the camera is. `set({ camera })` moves it. */
  readonly camera: Camera;
  readonly selection: readonly DiagramItem[];
  select(items: readonly DiagramItem[]): void;
  /** Items at a canvas point, topmost first. */
  pick(point: Point, options?: { readonly radiusPx?: number }): Promise<readonly DiagramHit[]>;
  /** An item's canvas point, or null when it is not drawn. */
  locate(item: DiagramItem): Point | null;
  /** The item, its wires, and what they join. */
  neighborhood(item: DiagramItem): readonly DiagramItem[];
  /** Frame the items, or follow the whole diagram. */
  fit(items?: readonly DiagramItem[], options?: kit.SetOptions): void;
  /** Pan just enough to show the item. */
  reveal(item: DiagramItem, options?: kit.SetOptions): void;
  stats(): DiagramStats;
}
/** Draw a model as a block diagram: vertices, ports, wires, and groups, on a canvas or offscreen. */
export function createDiagram(gpu: Gpu, config: DiagramConfig): Diagram {
  return new DiagramView(gpu, config);
}
interface Presented {
  scene: Scene;
  picking: Picking;
  camera: kit.Camera2D;
  viewport: kit.Viewport;
  revision: number;
  at?: number;
}
interface Staged extends Presented {
  paint: Paint;
  prepareMs: number;
  hover: DiagramHit | null;
  hoverState: kit.HoverState;
  fit: boolean;
  off(): void;
}
const KEYS = new Set([
  'canvas',
  'at',
  'paused',
  'source',
  'vertices',
  'edges',
  'groups',
  'layout',
  'camera',
  'input',
  'shade',
  'limits',
  ...Object.keys(defaults),
]);
interface Resolved {
  readonly config: DiagramConfig;
  readonly data: DiagramData;
  readonly options: Style;
  readonly limits: Required<Limits>;
  readonly layout: Required<LayoutOptions>;
}
function resolve(config: DiagramConfig): Resolved {
  for (const key of Object.keys(config)) if (!KEYS.has(key)) fail('Unknown diagram option: ' + key);
  return {
    config,
    data: checkedData(diagramData(config)),
    options: checkedOptions(config),
    limits: checkedLimits(config.limits),
    layout: layoutOptions(config.layout),
  };
}
/** Style options drawn through uniforms; any other change rereads the scene. */
const UNIFORMS: readonly (keyof Style)[] = [
  'grid',
  'snap',
  'gridColor',
  'hoverColor',
  'selectedColor',
  'msaa',
  'motion',
  'animationMs',
  'pickRadiusPx',
  'fitPaddingPx',
  'revealPaddingPx',
  'hover',
  'hoverBudgetMs',
  'outlineWidthPx',
  'selectionWidthPx',
  'hoverWidthPx',
  'gridMinSpacingPx',
  'detail',
];
function view(camera: kit.Camera2D | undefined, fit: boolean): Camera {
  return Object.freeze({
    center: camera ? camera.center : ([0, 0] as Point),
    scale: camera ? camera.scale[0] : 1,
    fit,
  });
}
function camera2d(center: Point, scale: number): kit.Camera2D {
  if (center?.length !== 2 || !center.every(Number.isFinite)) fail('Invalid camera center');
  positive(scale, 'camera scale');
  return { center: [center[0], center[1]], scale: [scale, scale], yDirection: 'down' };
}
class DiagramView extends kit.BaseView<DiagramConfig, DiagramEvents, Records, Merged> {
  private data: DiagramData;
  private options: Style;
  private limits: Required<Limits>;
  private layout: Required<LayoutOptions>;
  private resolved?: Resolved;
  private shade: Shade | null;
  private painter: Painter;
  private revision = 0;
  private closed = false;
  private requestedCamera?: kit.Camera2D;
  private fitting = true;
  private fitItems?: readonly DiagramItem[];
  private presented?: Presented;
  private stable?: Presented;
  private overlay: Overlay | null = null;
  private staged?: Staged;
  private selected: readonly DiagramItem[] = [];
  private pointer: Point | null = null;
  private hover: DiagramHit | null = null;
  private hoverState: kit.HoverState = 'idle';
  private reported?: Camera;
  private frames = 0;
  private currentStats: DiagramStats = {
    vertices: 0,
    edges: 0,
    ends: 0,
    geometryBytes: 0,
    pickingBytes: 0,
    prepareMs: 0,
    drawCalls: 0,
    frames: 0,
    hover: 'idle',
  };
  private animation?: { from: kit.Camera2D; to: kit.Camera2D; start: number };
  private transitionRequested = false;
  private sceneTransition?: {
    target: Scene;
    picking: Picking;
    from: ReadonlyMap<string, Point>;
    revision: number;
    at?: number;
    start: number;
  };
  private clock = 0;
  private shadeSerial = 0;
  private format: GPUTextureFormat = 'rgba8unorm';
  private reducedMotion = false;
  private drag?: { keys: Set<string>; delta: Point; serial: number };
  private dragSerial = 0;
  private interruptedTransition = false;
  private relayout = false;
  private shadeAnimating = false;
  constructor(gpu: Gpu, config: DiagramConfig) {
    super(gpu, config, {
      records: ['vertices', 'edges', 'groups'],
      merged: ['camera', 'input', 'limits', 'layout'],
      shorthands: { layout: 'algorithm' },
    });
    const resolved = resolve(this.config);
    this.data = resolved.data;
    this.options = resolved.options;
    this.limits = resolved.limits;
    this.layout = resolved.layout;
    this.shade = config.shade ?? null;
    this.painter = new Painter(gpu);
    const camera = config.camera ?? {};
    if (camera.center || camera.scale) {
      this.requestedCamera = camera2d(camera.center ?? [0, 0], camera.scale ?? 1);
      this.fitting = camera.fit ?? false;
    }
    this.start();
  }

  get camera(): Camera {
    const presented = this.presented?.camera,
      c = this.fitting ? (presented ?? this.requestedCamera) : (this.requestedCamera ?? presented);
    return view(c, this.fitting);
  }
  get selection(): readonly DiagramItem[] {
    return this.selected;
  }
  select(items: readonly DiagramItem[]): void {
    this.live();
    if (this.defer('selection', () => this.select(items))) return;
    this.selected = [...new Map(items.map((i) => [itemKey(i), i])).values()];
    this.invalidate();
  }
  pick(point: Point, options: { readonly radiusPx?: number } = {}): Promise<readonly DiagramHit[]> {
    return new Promise((resolve) => {
      this.live();
      resolve(this.hit(point, options.radiusPx));
    });
  }
  locate(item: DiagramItem): Point | null {
    const p = this.presented;
    if (!p) return null;
    const point = p.picking.locate(item);
    return point ? kit.cameraPoint(p.camera, point, p.viewport) : null;
  }
  neighborhood(item: DiagramItem): readonly DiagramItem[] {
    const scene = this.presented?.scene;
    if (!scene) return [];
    const result = new Map<string, DiagramItem>([[itemKey(item), item]]),
      vertices = new Set<number>();
    scene.vertices.forEach((n, i) => {
      if (
        item.kind === 'group'
          ? n.group === item.id
          : item.kind !== 'edge' && n.hit.type === item.type && n.hit.id === item.id
      )
        vertices.add(i);
    });
    for (const e of scene.edges)
      if (
        (item.kind === 'edge' && item.type === e.hit.type && item.id === e.hit.id) ||
        e.ends.some((end) => vertices.has(end.vertex))
      ) {
        result.set(itemKey(e.hit), e.hit);
        for (const end of e.ends) {
          const n = scene.vertices[end.vertex];
          result.set(itemKey(n.hit), n.hit);
        }
      }
    for (const i of vertices) result.set(itemKey(scene.vertices[i].hit), scene.vertices[i].hit);
    return [...result.values()];
  }
  fit(items?: readonly DiagramItem[], options: kit.SetOptions = {}): void {
    this.live();
    if (this.defer('camera', () => this.fit(items, options))) return;
    this.desiredCamera = undefined;
    this.fitting = !items;
    this.fitItems = items;
    if (this.presented) {
      const boxes = this.presented.picking.bounds(items);
      if (boxes.length) {
        const next = this.fitted(union(boxes), this.presented.viewport);
        this.requestedCamera = next;
        if (options.animate && this.motion() && this.options.animationMs > 0)
          this.animation = { from: this.presented.camera, to: next, start: this.clock };
        else this.animation = undefined;
      }
    }
    this.invalidate();
  }
  reveal(item: DiagramItem, options: kit.SetOptions = {}): void {
    this.live();
    if (this.defer('camera', () => this.reveal(item, options))) return;
    const point = this.presented?.picking.locate(item);
    if (!point || !this.presented) return;
    const p = kit.cameraPoint(this.presented.camera, point, this.presented.viewport),
      padding = this.options.revealPaddingPx;
    if (
      p[0] >= padding &&
      p[1] >= padding &&
      p[0] <= this.presented.viewport.width - padding &&
      p[1] <= this.presented.viewport.height - padding
    ) {
      this.animation = undefined;
      return;
    }
    this.aim({ ...this.presented.camera, center: point }, options);
  }
  stats(): DiagramStats {
    return { ...this.currentStats, hover: this.hoverState };
  }

  protected check(config: DiagramConfig): void {
    this.resolved = resolve(config);
  }
  protected configure(previous: DiagramConfig, next: DiagramConfig, options: kit.SetOptions): void {
    const resolved = this.resolved?.config === next ? this.resolved : resolve(next);
    this.resolved = undefined;
    const animate = options.animate === true;
    this.limits = resolved.limits;
    if (
      previous.source !== next.source ||
      previous.vertices !== next.vertices ||
      previous.edges !== next.edges ||
      previous.groups !== next.groups ||
      previous.limits !== next.limits
    ) {
      this.data = resolved.data;
      this.reread(animate);
    }
    if (previous.layout !== next.layout) {
      this.layout = resolved.layout;
      this.reread(animate);
      this.relayout = true;
    }
    if (previous.shade !== next.shade) this.compile(next.shade ?? null);
    const before = this.options;
    this.options = resolved.options;
    const changed = (Object.keys(defaults) as (keyof Style)[]).filter((key) => {
      const a = this.options[key],
        b = before[key];
      return Array.isArray(a) && Array.isArray(b)
        ? a.length !== b.length || a.some((v, i) => v !== b[i])
        : a !== b;
    });
    if (changed.some((key) => !UNIFORMS.includes(key))) this.reread(false);
    this.invalidate();
  }
  /** Null fits the whole diagram. */
  protected moveCamera(patch: Partial<Camera> | null, options: kit.SetOptions): void {
    if (patch?.center || patch?.scale) camera2d(patch.center ?? [0, 0], patch.scale ?? 1);
    if (this.deferCamera(patch, options)) return;
    if (patch === null || patch.fit) {
      this.fit(undefined, options);
      return;
    }
    const current = this.presented?.camera ?? this.requestedCamera;
    if (patch.center || patch.scale)
      this.aim(
        camera2d(patch.center ?? current?.center ?? [0, 0], patch.scale ?? current?.scale[0] ?? 1),
        options,
      );
    else if (patch.fit === false) this.stay();
  }
  protected attach(canvas: HTMLCanvasElement): () => void {
    return attachInput(canvas, (this.config.input ?? {}) as DiagramInput, this.controls());
  }
  private controls(): Controls {
    return {
      emit: (event, value) => this.emit(event, value),
      selection: () => this.selected,
      select: (items) => this.select(items),
      revision: () => this.revision,
      scene: () => this.presented?.scene,
      options: () => this.options,
      world: (p) =>
        this.presented ? kit.worldPoint(this.presented.camera, p, this.presented.viewport) : null,
      marquee: (a, b) =>
        this.presented?.picking.marquee([
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
        ]) ?? [],
      preview: (items, delta) => {
        if (this.defer('preview', () => this.controls().preview(items, delta))) return;
        if (this.sceneTransition) this.interruptedTransition = true;
        if (!delta && this.interruptedTransition) {
          // The drag starts from what was shown; cancellation must reread accepted positions.
          this.stable = this.stable ? { ...this.stable, revision: -1 } : undefined;
          this.interruptedTransition = false;
        }
        this.sceneTransition = undefined;
        this.transitionRequested = false;
        this.drag = delta
          ? { keys: this.movingKeys(items), delta, serial: ++this.dragSerial }
          : undefined;
        this.invalidate();
      },
      move: (items, delta) => this.move(items, delta),
      overlay: (value) => {
        if (this.defer('overlay', () => this.controls().overlay(value))) return;
        this.overlay = value;
        this.invalidate();
      },
      reduced: (value) => {
        if (this.defer('reduced', () => this.controls().reduced(value))) return;
        this.reducedMotion = value;
        this.invalidate();
      },
      hit: (point, radiusPx) => this.hit(point, radiusPx),
      pointer: (point) => this.point(point),
      pan: (dx, dy) => this.pan(dx, dy),
      zoom: (factor, anchor) => this.zoom(factor, anchor),
      stay: () => this.stay(),
      fit: () => this.fit(undefined, { animate: true }),
      reveal: (item) => this.reveal(item),
      locate: (item) => this.locate(item),
      invalidated: (listener) => kit.rendererOf(this).on!('invalidate', listener),
    };
  }

  private reread(animate: boolean): void {
    this.transitionRequested = animate;
    this.sceneTransition = undefined;
    this.revision++;
    this.drag = undefined;
  }
  private compile(shade: Shade | null): void {
    const serial = ++this.shadeSerial;
    this.painter.pipelines(this.format, this.options.msaa, shade).then(
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
  /** Emit after the current task, so listeners never run inside a frame. */
  private notify<K extends keyof DiagramEvents>(event: K, value: DiagramEvents[K]): void {
    queueMicrotask(() => {
      if (!this.closed) this.emit(event, value);
    });
  }
  /** Move the camera to a place; any explicit move stops fitting. */
  private desiredCamera?: kit.Camera2D;
  private aim(next: kit.Camera2D, options: kit.SetOptions = {}): void {
    if (this.defer('camera', () => this.aim(next, options))) {
      this.desiredCamera = next;
      return;
    }
    this.desiredCamera = undefined;
    this.fitting = false;
    this.fitItems = undefined;
    this.requestedCamera = next;
    if (options.animate && this.presented && this.motion() && this.options.animationMs > 0)
      this.animation = { from: this.presented.camera, to: next, start: this.clock };
    else this.animation = undefined;
    this.invalidate();
  }
  private stay(): void {
    const c = this.presented?.camera;
    if (c) this.aim(c);
  }
  private motion(): boolean {
    return (
      this.options.motion !== 'reduce' && !(this.options.motion === 'auto' && this.reducedMotion)
    );
  }
  private fitted(bounds: Rect, viewport: kit.Viewport): kit.Camera2D {
    return kit.fitCamera(bounds, viewport, this.options.fitPaddingPx, { yDirection: 'down' });
  }
  private pan(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) fail('Invalid pan');
    const c = this.desiredCamera ?? this.requestedCamera ?? this.presented?.camera;
    if (!c) return;
    this.aim({ ...c, center: [c.center[0] - dx / c.scale[0], c.center[1] - dy / c.scale[1]] });
  }
  private zoom(factor: number, anchor?: Point): void {
    positive(factor, 'zoom factor');
    const p = this.presented;
    if (!p) return;
    this.aim(
      kit.zoomCamera(
        this.desiredCamera ?? this.requestedCamera ?? p.camera,
        factor,
        anchor ?? [p.viewport.width / 2, p.viewport.height / 2],
        p.viewport,
      ),
    );
  }
  private point(point: Point | null): void {
    if (this.closed) return;
    if (point && !point.every(Number.isFinite)) fail('Invalid pointer');
    if (this.defer('pointer', () => this.point(point))) return;
    this.pointer = point;
    this.invalidate();
  }
  private hit(point: Point, radiusPx?: number): readonly DiagramHit[] {
    const p = this.presented;
    if (!p) return [];
    if (!point.every(Number.isFinite)) fail('Invalid hit point');
    const radius = radiusPx ?? this.options.pickRadiusPx;
    positive(radius, 'pick radius', true);
    if (point[0] < 0 || point[1] < 0 || point[0] > p.viewport.width || point[1] > p.viewport.height)
      return [];
    return p.picking.hit(
      point,
      p.camera,
      p.viewport,
      radius,
      undefined,
      this.options.detail === 'full' || Math.min(...p.camera.scale) > 0.2,
    ).items;
  }
  protected get animating(): boolean {
    return (
      !this.closed &&
      (!!this.animation ||
        !!this.sceneTransition ||
        this.shadeAnimating ||
        (this.motion() &&
          (this.presented?.scene.edges.some((e) => e.visible && e.flow !== 0) ?? false)))
    );
  }
  private movingKeys(items: readonly DiagramItem[]): Set<string> {
    const keys = new Set(items.map(itemKey));
    const scene = this.stable?.scene ?? this.presented?.scene;
    if (!scene) return keys;
    const groups = new Map(scene.groups.map((g) => [g.id, g]));
    const selected = new Set(items.filter((i) => i.kind === 'group').map((i) => i.id));
    for (const vertex of scene.vertices)
      for (let group = vertex.group; group; group = groups.get(group)?.parent)
        if (selected.has(group)) {
          keys.add(itemKey(vertex.hit));
          break;
        }
    return keys;
  }
  private move(items: readonly DiagramItem[], delta: Point): MoveProposal | undefined {
    const scene = this.stable?.scene ?? this.presented?.scene;
    if (!scene) return;
    const keys = this.movingKeys(items),
      indices = new Set<number>(),
      vertices = scene.vertices.map((vertex, i) => {
        if (keys.has(itemKey(vertex.hit))) {
          indices.add(i);
          return { ...vertex, x: vertex.x + delta[0], y: vertex.y + delta[1] };
        }
        return vertex;
      });
    if (!indices.size) return;
    return {
      positions: positions(vertices, indices),
      moves: [...indices].map((i) => ({
        vertex: { type: vertices[i].index.type, id: vertices[i].hit.id },
        position: [vertices[i].x, vertices[i].y],
      })),
    };
  }
  protected async prepare(frame: kit.Preparation): Promise<void> {
    this.live();
    this.staged?.off();
    this.staged = undefined;
    const started = performance.now(),
      work = new Work(frame.signal, this.limits.prepareMs),
      revision = this.revision,
      options = this.options,
      data = this.data;
    const base = this.stable ?? this.presented;
    let scene: Scene, picking: Picking;
    if (
      this.sceneTransition &&
      (this.sceneTransition.revision !== revision || this.sceneTransition.at !== frame.at)
    )
      this.sceneTransition = undefined;
    const transition = this.sceneTransition;
    const transitioning =
      transition && transition.revision === revision && transition.at === frame.at && !this.drag;
    const cached = base && base.revision === revision && base.at === frame.at && !this.drag;
    if (transitioning) {
      scene = transition.target;
      picking = transition.picking;
    } else if (cached) {
      scene = base.scene;
      picking = base.picking;
    } else {
      if (this.drag && base && base.revision === revision) {
        scene = {
          ...base.scene,
          vertices: base.scene.vertices.map((n) => ({
            ...n,
            ports: n.ports.map((p) => ({ ...p })),
          })),
          edges: base.scene.edges.map((e) => ({ ...e })),
          groups: base.scene.groups.map((g) => ({ ...g })),
        };
      } else {
        scene = await readScene(
          data,
          frame,
          options,
          this.limits,
          (input, request) => this.gpu.measureText(input, request),
          work,
        );
        await place(
          scene,
          this.layout,
          options.gridPitch,
          frame.signal,
          this.relayout ? undefined : base?.scene,
          work,
        );
      }
      if (this.drag)
        for (const vertex of scene.vertices)
          if (this.drag.keys.has(itemKey(vertex.hit))) {
            vertex.x += this.drag.delta[0];
            vertex.y += this.drag.delta[1];
          }
      await geometry(scene, options, this.limits, frame.signal, base?.scene, work);
      picking = new Picking(scene, this.limits.pickingBytes);
      const scenes = new Set([
        scene,
        ...(this.stable ? [this.stable.scene] : []),
        ...(this.presented ? [this.presented.scene] : []),
      ]);
      const indices = new Set([
        picking,
        ...(this.stable ? [this.stable.picking] : []),
        ...(this.presented ? [this.presented.picking] : []),
      ]);
      if ([...indices].reduce((n, index) => n + index.bytes, 0) > this.limits.pickingBytes)
        throw new GpuError('resource-limit', 'Retained picking exceeds budget');
      if ([...scenes].reduce((n, value) => n + value.bytes, 0) > this.limits.geometryBytes)
        throw new GpuError('resource-limit', 'Retained geometry exceeds budget');
    }
    if (
      this.transitionRequested &&
      base &&
      !this.drag &&
      this.motion() &&
      options.animationMs > 0 &&
      scene.vertices.length <= options.animationMaxVertices &&
      scene.bytes * 3 + base.scene.bytes <= this.limits.geometryBytes &&
      picking.bytes * 3 + base.picking.bytes <= this.limits.pickingBytes
    ) {
      const from = new Map(
        base.scene.vertices.map((vertex) => [itemKey(vertex.hit), [vertex.x, vertex.y] as Point]),
      );
      if (
        scene.vertices.some((vertex) => {
          const p = from.get(itemKey(vertex.hit));
          return p && (p[0] !== vertex.x || p[1] !== vertex.y);
        })
      )
        this.sceneTransition = {
          target: scene,
          picking,
          from,
          revision,
          at: frame.at,
          start: frame.timeMs,
        };
    }
    this.transitionRequested = false;
    const movement = this.sceneTransition;
    if (
      movement &&
      movement.revision === revision &&
      movement.at === frame.at &&
      this.motion() &&
      options.animationMs > 0
    ) {
      const t = Math.min(1, Math.max(0, (frame.timeMs - movement.start) / options.animationMs));
      if (t < 1) {
        const ease = 1 - (1 - t) ** 3;
        scene = {
          ...movement.target,
          vertices: movement.target.vertices.map((vertex) => {
            const from = movement.from.get(itemKey(vertex.hit));
            return {
              ...vertex,
              ports: vertex.ports.map((port) => ({ ...port })),
              x: from ? from[0] + (vertex.x - from[0]) * ease : vertex.x,
              y: from ? from[1] + (vertex.y - from[1]) * ease : vertex.y,
            };
          }),
          edges: movement.target.edges.map((edge) => ({ ...edge })),
          groups: movement.target.groups.map((group) => ({ ...group })),
        };
        try {
          await geometry(scene, options, this.limits, frame.signal, base?.scene, work);
          picking = new Picking(scene, this.limits.pickingBytes);
          const retained = new Set([scene, movement.target, ...(base ? [base.scene] : [])]);
          const indices = new Set([picking, movement.picking, ...(base ? [base.picking] : [])]);
          if (
            [...retained].reduce((sum, item) => sum + item.bytes, 0) > this.limits.geometryBytes ||
            [...indices].reduce((sum, item) => sum + item.bytes, 0) > this.limits.pickingBytes
          )
            throw new GpuError('resource-limit', 'Transition exceeds retained budgets');
        } catch (error) {
          frame.signal.throwIfAborted();
          if (
            !(error instanceof GpuError) ||
            !['invalid-input', 'resource-limit'].includes(error.code)
          )
            throw error;
          // Intermediate positions may overlap even when both layouts are valid.
          scene = movement.target;
          picking = movement.picking;
          this.sceneTransition = undefined;
        }
      }
    }
    frame.signal.throwIfAborted();
    this.live();
    let c =
      this.requestedCamera ??
      base?.camera ??
      ({ center: [0, 0], scale: [1, 1], yDirection: 'down' } as kit.Camera2D);
    if (this.fitting && scene.vertices.some((n) => n.visible))
      c = this.fitted(scene.bounds, frame.viewport);
    if (this.fitItems) {
      const boxes = picking.bounds(this.fitItems);
      if (boxes.length) c = this.fitted(union(boxes), frame.viewport);
    }
    if (this.animation && this.motion() && options.animationMs > 0) {
      const a = this.animation,
        t = Math.min(1, Math.max(0, (frame.timeMs - a.start) / this.options.animationMs)),
        u = t * t * (3 - 2 * t);
      c = {
        center: [
          a.from.center[0] + (a.to.center[0] - a.from.center[0]) * u,
          a.from.center[1] + (a.to.center[1] - a.from.center[1]) * u,
        ],
        scale: [
          a.from.scale[0] + (a.to.scale[0] - a.from.scale[0]) * u,
          a.from.scale[1] + (a.to.scale[1] - a.from.scale[1]) * u,
        ],
        yDirection: a.to.yDirection,
      };
    }
    const hoverEnabled = this.pointer && options.hover !== 'off' && !this.drag;
    const hit = hoverEnabled
      ? picking.hit(
          this.pointer!,
          c,
          frame.viewport,
          options.pickRadiusPx,
          options.hover === 'auto' ? options.hoverBudgetMs : undefined,
          options.detail === 'full' || Math.min(...c.scale) > 0.2,
        )
      : undefined;
    const hover = hit?.items[0] ?? null,
      hoverState: kit.HoverState =
        options.hover === 'off'
          ? 'off'
          : this.drag
            ? 'moving'
            : hit && !hit.complete
              ? 'budget'
              : hover
                ? 'active'
                : 'idle';
    const effective = this.motion() ? options : { ...options, motion: 'reduce' as const };
    const paint = await this.painter.prepare(
      frame,
      scene,
      effective,
      c,
      this.selected,
      hover,
      this.shade,
      this.pointer,
      this.overlay,
    );
    this.shadeAnimating = this.painter.animating;
    work.check();
    this.live();
    const abort = () => {
      if (this.staged === candidate) this.staged = undefined;
    };
    const candidate: Staged = {
      scene,
      picking,
      camera: c,
      viewport: frame.viewport,
      revision: this.drag ? -1 : revision,
      at: frame.at,
      paint,
      prepareMs: performance.now() - started,
      hover,
      hoverState,
      fit: this.fitting,
      off: () => frame.signal.removeEventListener('abort', abort),
    };
    frame.signal.addEventListener('abort', abort, { once: true });
    this.staged = candidate;
    this.format = frame.format;
  }
  protected discard(): void {
    this.staged?.off();
    this.staged = undefined;
  }
  protected encode(frame: kit.Encoding): void {
    this.live();
    if (!this.staged) throw new GpuError('invalid-input', 'Diagram is not prepared');
    this.painter.encode(frame, this.staged.paint);
  }
  protected submitted(frame: kit.FrameInfo): void {
    const next = this.staged;
    if (!next || this.closed) return;
    next.off();
    this.staged = undefined;
    this.presented = {
      scene: next.scene,
      picking: next.picking,
      camera: next.camera,
      viewport: next.viewport,
      revision: next.revision,
      at: next.at,
    };
    if (next.revision >= 0) {
      this.stable = this.presented;
      const selected = this.selected.filter((item) => next.picking.has(item));
      if (selected.length !== this.selected.length) {
        this.selected = selected;
        this.notify('select', selected);
      }
    }
    if (
      this.sceneTransition &&
      (!this.motion() || frame.timeMs >= this.sceneTransition.start + this.options.animationMs)
    )
      this.sceneTransition = undefined;
    this.clock = frame.timeMs;
    this.relayout = false;
    if (
      this.animation &&
      (!this.motion() || frame.timeMs >= this.animation.start + this.options.animationMs)
    )
      this.animation = undefined;
    this.currentStats = {
      vertices: next.scene.vertices.length,
      edges: next.scene.edges.length,
      ends: next.scene.ends,
      geometryBytes: next.scene.bytes,
      pickingBytes: next.picking.bytes,
      prepareMs: next.prepareMs,
      drawCalls: next.paint.drawCalls,
      frames: ++this.frames,
      hover: next.hoverState,
    };
    this.hoverState = next.hoverState;
    if ((this.hover ? itemKey(this.hover) : null) !== (next.hover ? itemKey(next.hover) : null)) {
      this.hover = next.hover;
      this.notify('hover', this.hover);
    }
    const camera = view(next.camera, next.fit),
      reported = this.reported;
    if (
      !reported ||
      reported.center[0] !== camera.center[0] ||
      reported.center[1] !== camera.center[1] ||
      reported.scale !== camera.scale ||
      reported.fit !== camera.fit
    ) {
      this.reported = camera;
      this.notify('camera', camera);
    }
  }
  protected release(): void {
    this.closed = true;
    this.shadeSerial++;
    this.staged?.off();
    this.staged = undefined;
    this.presented = undefined;
    this.stable = undefined;
    this.animation = undefined;
    this.sceneTransition = undefined;
    this.transitionRequested = false;
    this.painter.destroy();
  }
}
