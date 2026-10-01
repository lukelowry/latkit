import { GpuError, fitCamera, cameraPoint, worldPoint, zoomCamera } from '@latkit/gpu';
import type {
  Camera2D,
  ContextMenu,
  FieldValues,
  Gpu,
  HoverState,
  Invalidation,
  Renderer,
  Shade,
  Preparation,
  Encoding,
  FrameInfo,
  Viewport,
} from '@latkit/gpu';
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
import { itemKey } from './data.js';
import type { Limits, Options } from './options.js';
import {
  data as checkedData,
  options as checkedOptions,
  limits as checkedLimits,
  patch,
  sources,
  positive,
  fail,
} from './config.js';
import { place, layoutOptions, type LayoutOptions } from './layout.js';
import { readScene } from './read.js';
import { geometry } from './geometry.js';
import { positions, type Scene, type Rect } from './scene.js';
import { Picking } from './picking.js';
import { Work } from './work.js';
import { union } from './spatial.js';
import { Painter, type Paint, type Overlay } from './painter.js';
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
export interface MoveProposal {
  readonly positions: Readonly<Record<string, FieldValues>>;
  readonly moves: readonly { readonly vertex: RowRef; readonly position: Point }[];
}
export interface DiagramEvents {
  readonly invalidate: Invalidation;
  readonly hover: DiagramHit | null;
  readonly select: readonly DiagramItem[];
  readonly contextmenu: ContextMenu<DiagramHit>;
  readonly open: DiagramItem;
  readonly connect: ConnectProposal;
  readonly move: MoveProposal;
  readonly delete: readonly string[];
  readonly fit: boolean;
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
  readonly hover: HoverState;
}
export interface Diagram extends Renderer {
  setData(data: DiagramData, options?: { readonly animate?: boolean }): void;
  setVertex(type: string, patch: Partial<VertexOptions>): void;
  setEdge(type: string, patch: Partial<EdgeOptions>): void;
  setGroup(id: string, patch: Partial<Group>): void;
  setOptions(options: Options): void;
  setLayout(options: LayoutOptions, transition?: { readonly animate?: boolean }): void;
  setShade(shade: Shade | null): Promise<void>;
  getCamera(): Camera2D | null;
  setCamera(camera: Camera2D, options?: { readonly animate?: boolean }): void;
  fit(options?: { readonly items?: readonly DiagramItem[]; readonly animate?: boolean }): void;
  reveal(
    item: DiagramItem,
    options?: { readonly animate?: boolean; readonly neighbors?: boolean },
  ): void;
  neighborhood(item: DiagramItem): readonly DiagramItem[];
  panBy(dx: number, dy: number): void;
  zoomBy(factor: number, anchor?: Point): void;
  select(items: readonly DiagramItem[]): void;
  setPointer(point: Point | null): void;
  hitTest(point: Point, options?: { readonly radiusPx?: number }): readonly DiagramHit[];
  locate(item: DiagramItem): Point | null;
  toDiagram(point: Point): Point | null;
  stats(): DiagramStats;
  on<K extends keyof DiagramEvents>(
    event: K,
    listener: (value: DiagramEvents[K]) => void,
  ): () => void;
}
export interface DiagramOptions {
  readonly gpu: Gpu;
  readonly data: DiagramData;
  readonly camera?: Camera2D;
  readonly options?: Options;
  readonly limits?: Limits;
  readonly shade?: Shade;
  readonly layout?: LayoutOptions;
}
export function createDiagram(options: DiagramOptions): Diagram {
  return new View(options);
}
interface Presented {
  scene: Scene;
  picking: Picking;
  camera: Camera2D;
  viewport: Viewport;
  revision: number;
  at?: number;
}
interface Staged extends Presented {
  paint: Paint;
  prepareMs: number;
  hover: DiagramHit | null;
  hoverState: HoverState;
  fit: boolean;
  off(): void;
}
export interface Interaction {
  emit<K extends Exclude<keyof DiagramEvents, 'invalidate' | 'fit' | 'hover'>>(
    event: K,
    value: DiagramEvents[K],
  ): void;
  selection(): readonly DiagramItem[];
  revision(): number;
  scene(): Scene | undefined;
  options(): Required<Options>;
  world(point: Point): Point | null;
  marquee(a: Point, b: Point): readonly DiagramItem[];
  preview(items: readonly DiagramItem[], delta: Point | null): void;
  move(items: readonly DiagramItem[], delta: Point): MoveProposal | undefined;
  reduced(value: boolean): void;
  overlay(value: Overlay | null): void;
}
const interactions = new WeakMap<Diagram, Interaction>();
export function interaction(diagram: Diagram): Interaction {
  const value = interactions.get(diagram);
  if (!value) fail('Input requires a diagram created by createDiagram');
  return value;
}
function camera(value: Camera2D): Camera2D {
  if (
    value.center.length !== 2 ||
    !value.center.every(Number.isFinite) ||
    value.scale.length !== 2 ||
    !value.scale.every((v) => Number.isFinite(v) && v > 0) ||
    !['up', 'down'].includes(value.yDirection)
  )
    fail('Invalid camera');
  return { center: [...value.center], scale: [...value.scale], yDirection: value.yDirection };
}
class View implements Diagram {
  private data: DiagramData;
  private options: Required<Options>;
  private limits: Required<Limits>;
  private layout: Required<LayoutOptions>;
  private shade: Shade | null;
  private painter: Painter;
  private listeners = new Map<keyof DiagramEvents, Set<(value: never) => void>>();
  private subscriptions: (() => void)[] = [];
  private revision = 0;
  private closed = false;
  private requestedCamera?: Camera2D;
  private fitting = true;
  private fitItems?: readonly DiagramItem[];
  private presented?: Presented;
  private stable?: Presented;
  private overlay: Overlay | null = null;
  private staged?: Staged;
  private selected: readonly DiagramItem[] = [];
  private pointer: Point | null = null;
  private hover: DiagramHit | null = null;
  private hoverState: HoverState = 'idle';
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
  private animation?: { from: Camera2D; to: Camera2D; start: number };
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
  constructor(private readonly construction: DiagramOptions) {
    this.data = checkedData(construction.data);
    this.options = checkedOptions(construction.options);
    this.limits = checkedLimits(construction.limits);
    this.layout = layoutOptions(construction.layout);
    this.shade = construction.shade ?? null;
    this.painter = new Painter(construction.gpu);
    if (construction.camera) {
      this.requestedCamera = camera(construction.camera);
      this.fitting = false;
    }
    this.subscribe();
    interactions.set(this, {
      emit: (event, value) => this.emit(event, value),
      selection: () => this.selected,
      revision: () => this.revision,
      scene: () => this.presented?.scene,
      options: () => this.options,
      world: (p) =>
        this.presented ? worldPoint(this.presented.camera, p, this.presented.viewport) : null,
      marquee: (a, b) =>
        this.presented?.picking.marquee([
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
        ]) ?? [],
      preview: (items, delta) => {
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
        this.overlay = value;
        this.invalidate('refresh');
      },
      reduced: (value) => {
        this.reducedMotion = value;
        this.invalidate('refresh');
      },
    });
  }
  private live(): void {
    if (this.closed) throw new GpuError('closed', 'Diagram is destroyed');
  }
  private emit<K extends keyof DiagramEvents>(event: K, value: DiagramEvents[K]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(value as never);
  }
  private notify<K extends keyof DiagramEvents>(event: K, value: DiagramEvents[K]): void {
    queueMicrotask(() => {
      if (!this.closed) this.emit(event, value);
    });
  }
  private invalidate(change: Invalidation = 'replace'): void {
    if (!this.closed) this.emit('invalidate', change);
  }
  on<K extends keyof DiagramEvents>(
    event: K,
    listener: (value: DiagramEvents[K]) => void,
  ): () => void {
    this.live();
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (value: never) => void);
    return () => {
      set!.delete(listener as (value: never) => void);
    };
  }
  private subscribe(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    for (const source of sources(this.data))
      this.subscriptions.push(
        source.on('change', (change) => {
          if (this.closed) return;
          if (change.kind === 'status') {
            this.invalidate('refresh');
            return;
          }
          this.revision++;
          this.sceneTransition = undefined;
          this.transitionRequested = false;
          this.drag = undefined;
          this.invalidate(change.kind === 'append' ? 'refresh' : 'replace');
        }),
      );
  }
  setData(value: DiagramData, options: { readonly animate?: boolean } = {}): void {
    this.live();
    this.data = checkedData(value);
    this.transitionRequested = options.animate === true;
    this.sceneTransition = undefined;
    this.revision++;
    this.drag = undefined;
    this.subscribe();
    this.invalidate();
  }
  setVertex(type: string, value: Partial<VertexOptions>): void {
    if (!this.data.vertices[type]) fail('Unknown vertex type: ' + type);
    this.setData({
      ...this.data,
      vertices: { ...this.data.vertices, [type]: patch(this.data.vertices[type], value) },
    });
  }
  setEdge(type: string, value: Partial<EdgeOptions>): void {
    if (!this.data.edges?.[type]) fail('Unknown edge type: ' + type);
    this.setData({
      ...this.data,
      edges: { ...this.data.edges, [type]: patch(this.data.edges[type], value) },
    });
  }
  setGroup(id: string, value: Partial<Group>): void {
    if (!this.data.groups?.[id]) fail('Unknown group: ' + id);
    this.setData({
      ...this.data,
      groups: { ...this.data.groups, [id]: patch(this.data.groups[id], value) },
    });
  }
  setOptions(value: Options): void {
    this.live();
    const next = checkedOptions(value, this.options);
    const changed = (Object.keys(value) as (keyof Options)[]).filter((key) => {
      const a = next[key],
        b = this.options[key];
      return Array.isArray(a) && Array.isArray(b)
        ? a.length !== b.length || a.some((v, i) => v !== b[i])
        : a !== b;
    });
    if (!changed.length) return;
    this.options = next;
    const uniforms: readonly (keyof Options)[] = [
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
    if (changed.some((key) => !uniforms.includes(key))) {
      this.revision++;
      this.sceneTransition = undefined;
      this.transitionRequested = false;
      this.invalidate();
    } else this.invalidate('refresh');
  }
  setLayout(value: LayoutOptions, transition: { readonly animate?: boolean } = {}): void {
    this.live();
    this.layout = layoutOptions(value);
    this.transitionRequested = transition.animate === true;
    this.sceneTransition = undefined;
    this.revision++;
    this.relayout = true;
    this.invalidate();
  }
  async setShade(shade: Shade | null): Promise<void> {
    this.live();
    const serial = ++this.shadeSerial;
    await this.painter.pipelines(this.format, this.options.msaa, shade);
    this.live();
    if (serial === this.shadeSerial) {
      this.shade = shade;
      this.invalidate();
    }
  }
  getCamera(): Camera2D | null {
    return this.presented ? camera(this.presented.camera) : null;
  }
  setCamera(value: Camera2D, options: { readonly animate?: boolean } = {}): void {
    this.live();
    const next = camera(value);
    this.fitting = false;
    this.fitItems = undefined;
    this.requestedCamera = next;
    if (options.animate && this.presented && this.motion() && this.options.animationMs > 0)
      this.animation = { from: this.presented.camera, to: next, start: this.clock };
    else this.animation = undefined;
    this.invalidate();
  }
  private motion(): boolean {
    return (
      this.options.motion !== 'reduce' && !(this.options.motion === 'auto' && this.reducedMotion)
    );
  }
  fit(options: { readonly items?: readonly DiagramItem[]; readonly animate?: boolean } = {}): void {
    this.live();
    this.fitting = !options.items;
    this.fitItems = options.items;
    if (this.presented) {
      const boxes = this.presented.picking.bounds(options.items);
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
  private fitted(bounds: Rect, viewport: Viewport): Camera2D {
    return fitCamera(bounds, viewport, this.options.fitPaddingPx, {
      yDirection: this.requestedCamera?.yDirection ?? 'down',
    });
  }
  reveal(
    item: DiagramItem,
    options: { readonly animate?: boolean; readonly neighbors?: boolean } = {},
  ): void {
    this.live();
    if (options.neighbors) {
      this.fit({ items: this.neighborhood(item), animate: options.animate });
      return;
    }
    const point = this.presented?.picking.locate(item);
    if (!point || !this.presented) return;
    const p = cameraPoint(this.presented.camera, point, this.presented.viewport),
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
    this.setCamera({ ...this.presented.camera, center: point }, options);
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
  panBy(dx: number, dy: number): void {
    this.live();
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) fail('Invalid pan');
    const c = this.requestedCamera ?? this.presented?.camera;
    if (!c) return;
    this.setCamera({
      ...c,
      center: [
        c.center[0] - dx / c.scale[0],
        c.center[1] - (dy / c.scale[1]) * (c.yDirection === 'down' ? 1 : -1),
      ],
    });
  }
  zoomBy(factor: number, anchor?: Point): void {
    this.live();
    positive(factor, 'zoom factor');
    const p = this.presented;
    if (!p) return;
    this.setCamera(
      zoomCamera(
        this.requestedCamera ?? p.camera,
        factor,
        anchor ?? [p.viewport.width / 2, p.viewport.height / 2],
        p.viewport,
      ),
    );
  }
  select(items: readonly DiagramItem[]): void {
    this.live();
    this.selected = [...new Map(items.map((i) => [itemKey(i), i])).values()];
    this.invalidate('refresh');
  }
  setPointer(point: Point | null): void {
    this.live();
    if (point && !point.every(Number.isFinite)) fail('Invalid pointer');
    this.pointer = point;
    this.invalidate('refresh');
  }
  hitTest(point: Point, options: { readonly radiusPx?: number } = {}): readonly DiagramHit[] {
    this.live();
    const p = this.presented;
    if (!p) return [];
    if (!point.every(Number.isFinite)) fail('Invalid hit point');
    const radius = options.radiusPx ?? this.options.pickRadiusPx;
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
  locate(item: DiagramItem): Point | null {
    const p = this.presented;
    if (!p) return null;
    const point = p.picking.locate(item);
    return point ? cameraPoint(p.camera, point, p.viewport) : null;
  }
  toDiagram(point: Point): Point | null {
    const p = this.presented;
    if (!p) return null;
    const world = worldPoint(p.camera, point, p.viewport),
      g = this.options.gridPitch;
    return this.options.snap ? [Math.round(world[0] / g) * g, Math.round(world[1] / g) * g] : world;
  }
  stats(): DiagramStats {
    return { ...this.currentStats, hover: this.hoverState };
  }
  get animating(): boolean {
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
  async prepare(frame: Preparation): Promise<void> {
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
          (input, request) => this.construction.gpu.measureText(input, request),
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
      ({ center: [0, 0], scale: [1, 1], yDirection: 'down' } as Camera2D);
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
      hoverState: HoverState =
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
  encode(frame: Encoding): void {
    this.live();
    if (!this.staged) throw new GpuError('invalid-input', 'Diagram is not prepared');
    this.painter.encode(frame, this.staged.paint);
  }
  submitted(frame: FrameInfo): void {
    const next = this.staged;
    if (!next || this.closed) return;
    next.off();
    this.staged = undefined;
    const beforeFit = this.presented ? this.currentFit : undefined;
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
    this.currentFit = next.fit;
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
    if (beforeFit !== next.fit) this.notify('fit', next.fit);
  }
  private currentFit = true;
  destroy(): void {
    if (this.closed) return;
    this.invalidate();
    this.closed = true;
    this.staged?.off();
    this.staged = undefined;
    this.presented = undefined;
    this.stable = undefined;
    this.animation = undefined;
    this.sceneTransition = undefined;
    this.transitionRequested = false;
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    this.listeners.clear();
    this.painter.destroy();
    interactions.delete(this);
  }
}
