import {
  GpuError,
  kit,
  viewStyle,
  type Gpu,
  type ItemEvents,
  type ItemView,
  type ItemViewConfig,
  type SetOptions,
  type Shade,
  type ViewCamera,
  type ViewInput,
  type ViewStats,
} from '@latkit/gpu';
import type { FieldValues } from '@latkit/model';
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
import { FIELD_OPTIONS, diagramData, itemKey } from './data.js';
import type { DiagramStyle, Limits } from './options.js';
import {
  DEFAULTS,
  checkInput,
  data as checkedData,
  fail,
  positive,
  resolveLimits,
  resolveStyle,
  type Style,
} from './config.js';
import { place, layoutOptions, type Layout, type LayoutOptions } from './layout.js';
import { readScene, sampled } from './read.js';
import { geometry } from './geometry.js';
import { positions, type Scene } from './scene.js';
import { Picking } from './picking.js';
import { union } from './spatial.js';
import { Painter, type Paint, type Overlay } from './painter.js';
import { listen, type Controls, type DiagramInput, type Gestures } from './input.js';
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
  readonly positions: Readonly<Record<string, FieldValues>>;
  readonly moves: readonly { readonly vertex: RowRef; readonly position: Point }[];
}
export interface Camera extends ViewCamera {
  /** Diagram units at the canvas center. */
  readonly center: Point;
  /** Pixels per diagram unit. */
  readonly scale: number;
}
export interface DiagramConfig extends ItemViewConfig, DiagramStyle {
  /** Drawn types by model type name. */
  readonly vertices: Readonly<Record<string, VertexOptions>>;
  readonly edges?: Readonly<Record<string, EdgeOptions>>;
  readonly groups?: Readonly<Record<string, Group>>;
  /** How vertices are placed; `layered` by default, `manual` keeps model positions. */
  readonly layout?: Layout;
  /** Where the camera starts; `diagram.camera` is where it is. Fits the diagram by default. */
  readonly camera?: Partial<Camera>;
  /** Pointer and keyboard control of the canvas; `navigate` by default. */
  readonly input?: DiagramInput | NonNullable<DiagramInput['mode']>;
  readonly limits?: Limits;
}
export interface DiagramEvents extends ItemEvents<DiagramItem, DiagramHit, Camera> {
  /** Double click or Enter. */
  readonly open: DiagramItem;
  readonly connect: ConnectProposal;
  readonly move: MoveProposal;
  /** Delete or Backspace in edit mode: the selected rows' ids. */
  readonly delete: readonly string[];
}
export interface DiagramStats extends ViewStats {
  readonly vertices: number;
  readonly edges: number;
  readonly ends: number;
  readonly geometryBytes: number;
}
type Records = 'vertices' | 'edges' | 'groups';
type Merged = 'camera' | 'input' | 'limits' | 'layout';
export interface Diagram extends ItemView<
  DiagramConfig,
  DiagramItem,
  DiagramHit,
  Camera,
  DiagramEvents
> {
  /** `animate` eases vertices to new positions and the camera to a new place. */
  set(patch: kit.Patch<DiagramConfig, Records, Merged>, options?: SetOptions): void;
  /** The item, its wires, and what they join. */
  neighborhood(item: DiagramItem): readonly DiagramItem[];
  stats(): DiagramStats;
}
/** Draw a model as a block diagram: vertices, ports, wires, and groups, on a canvas or offscreen. */
export function createDiagram(gpu: Gpu, config: DiagramConfig): Diagram {
  return new DiagramView(gpu, config);
}
interface Presented {
  readonly scene: Scene;
  readonly picking: Picking;
  readonly camera: kit.Camera2D;
  readonly viewport: kit.Viewport;
  /** The scene's revision, or -1 for a drag preview. */
  readonly revision: number;
  readonly at?: number;
}
interface Staged extends Presented {
  readonly paint: Paint;
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
  ...Object.keys(viewStyle),
  ...Object.keys(DEFAULTS),
]);
interface Resolved {
  readonly config: DiagramConfig;
  readonly data: DiagramData;
  readonly limits: Required<Limits>;
  readonly layout: Required<LayoutOptions>;
}
function resolve(config: DiagramConfig): Resolved {
  for (const key of Object.keys(config)) if (!KEYS.has(key)) fail('Unknown diagram option: ' + key);
  checkInput(config.input as DiagramInput | undefined);
  resolveStyle(config);
  return {
    config,
    data: checkedData(diagramData(config)),
    limits: resolveLimits(config.limits),
    layout: layoutOptions(config.layout),
  };
}
/** Style options drawn through uniforms; any other change rereads the scene. */
const UNIFORMS = new Set<keyof Style>([
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
  'selectedWidthPx',
  'hoverWidthPx',
  'gridMinSpacingPx',
  'detail',
]);
function point(x: number, y: number): Point {
  return Object.freeze([x, y]) as unknown as Point;
}
const DEFAULT_CAMERA: Camera = Object.freeze({ center: point(0, 0), scale: 1, fit: true });
function camera2d(camera: Camera): kit.Camera2D {
  return { center: camera.center, scale: [camera.scale, camera.scale], yDirection: 'down' };
}
function inside(p: Point, viewport: kit.Viewport): boolean {
  return p[0] >= 0 && p[1] >= 0 && p[0] <= viewport.width && p[1] <= viewport.height;
}
/** Ports are picked once they are large enough to aim at. */
function portsShown(style: Style, camera: kit.Camera2D): boolean {
  return style.detail === 'full' || camera.scale[0] > 0.2;
}
const KINDS = new Set(['vertex', 'edge', 'port']);

class DiagramView
  extends kit.BaseItemView<
    DiagramConfig,
    DiagramEvents,
    DiagramItem,
    DiagramHit,
    Camera,
    Records,
    Merged
  >
  implements Diagram
{
  protected readonly framed = ['center', 'scale'] as const;
  private data: DiagramData;
  /** Whether the scene reads sampled fields; otherwise it is the same at every coordinate. */
  private sampled: boolean;
  private style: Style;
  private limits: Required<Limits>;
  private layout: Required<LayoutOptions>;
  private resolved?: Resolved;
  private readonly painter: Painter;
  private revision = 0;
  /** The latest drawn frame: what pick, locate, and selection see. */
  private shown?: Presented;
  /** The latest drawn frame of accepted positions, which drags start from. */
  private stable?: Presented;
  /** This frame's scene while its camera is framed. */
  private preparing?: { readonly scene: Scene; readonly picking: Picking };
  private overlay: Overlay | null = null;
  private staged?: Staged;
  private counts = { vertices: 0, edges: 0, ends: 0, geometryBytes: 0, drawCalls: 0 };
  /** Whether the shown scene has wires whose flow moves. */
  private flowing = false;
  private transitionRequested = false;
  private sceneTransition?: {
    target: Scene;
    picking: Picking;
    from: ReadonlyMap<string, Point>;
    revision: number;
    at?: number;
    start: number;
  };
  private drag?: { keys: Set<string>; delta: Point };
  private interruptedTransition = false;
  private relayout = false;
  private shadeAnimating = false;
  private gestures?: Gestures;
  private readonly controls: Controls = {
    emit: (event, value) => this.emit(event, value),
    selection: () => this.selection,
    choose: (items) => this.choose(items),
    revision: () => this.revision,
    scene: () => this.shown?.scene,
    options: () => this.style,
    world: (p) => (this.shown ? kit.worldPoint(this.shown.camera, p, this.shown.viewport) : null),
    marquee: (a, b) =>
      this.shown?.picking.marquee([
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      ]) ?? [],
    preview: (items, delta) => this.preview(items, delta),
    move: (items, delta) => this.move(items, delta),
    overlay: (value) => {
      if (this.defer('overlay', () => this.controls.overlay(value))) return;
      this.overlay = value;
      this.invalidate();
    },
    hits: (p, radiusPx = this.viewStyle.pickRadiusPx) => this.hits(p, radiusPx),
    menu: (p, modifiers) => void this.menu(p, 'pointer', modifiers),
    pan: (dx, dy) => this.pan(dx, dy),
    zoom: (factor, anchor) => this.zoom(factor, anchor),
    stay: () => {
      if (this.camera.fit) this.moveCamera({ fit: false }, {});
    },
    fit: () => this.fit(undefined, { animate: true }),
    reveal: (item) => this.reveal(item),
    invalidated: (listener) => kit.rendererOf(this).on!('invalidate', listener),
  };
  constructor(gpu: Gpu, config: DiagramConfig) {
    super(gpu, config, {
      records: ['vertices', 'edges', 'groups'],
      merged: ['camera', 'input', 'limits', 'layout'],
      shorthands: { layout: 'algorithm' },
      fields: FIELD_OPTIONS,
      nested: ['ports'],
    });
    const resolved = resolve(this.config);
    this.data = resolved.data;
    this.sampled = sampled(this.data);
    this.style = resolveStyle(this.config, this.viewStyle);
    this.limits = resolved.limits;
    this.layout = resolved.layout;
    this.painter = new Painter(gpu);
    // Reject an invalid starting camera now rather than at the first frame.
    void this.camera;
    this.start();
  }

  neighborhood(item: DiagramItem): readonly DiagramItem[] {
    const scene = this.shown?.scene;
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
  stats(): DiagramStats {
    return {
      ...super.stats(),
      ...this.counts,
      pickingBytes: this.shown?.picking.bytes ?? 0,
    };
  }

  protected defaultCamera(): Camera {
    return DEFAULT_CAMERA;
  }
  protected resolveCamera(camera: Camera): Camera {
    const { center, scale, fit, ...rest } = camera;
    const unknown = Object.keys(rest)[0];
    if (unknown !== undefined) fail('Unknown camera option: ' + unknown);
    if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite))
      fail('Invalid camera center');
    positive(scale, 'camera scale');
    if (typeof fit !== 'boolean') fail('Invalid camera fit');
    return Object.freeze({ center: point(center[0], center[1]), scale, fit });
  }
  protected framing(
    items: readonly DiagramItem[] | undefined,
    camera: Camera,
    viewport: kit.Viewport,
  ): Partial<Camera> | undefined {
    void camera;
    const prepared = this.preparing;
    if (!prepared) return undefined;
    const boxes = items ? prepared.picking.bounds(items) : [];
    if (!boxes.length && !prepared.picking.drawn) return undefined;
    const fitted = kit.fitCamera(
      boxes.length ? union(boxes) : prepared.scene.bounds,
      viewport,
      this.style.fitPaddingPx,
      { yDirection: 'down' },
    );
    return { center: point(fitted.center[0], fitted.center[1]), scale: fitted.scale[0] };
  }
  protected interpolate(from: Camera, to: Camera, t: number): Camera {
    return Object.freeze({
      center: point(
        from.center[0] + (to.center[0] - from.center[0]) * t,
        from.center[1] + (to.center[1] - from.center[1]) * t,
      ),
      scale: from.scale + (to.scale - from.scale) * t,
      fit: to.fit,
    });
  }
  protected panned(camera: Camera, dx: number, dy: number): Camera {
    return {
      ...camera,
      center: point(camera.center[0] - dx / camera.scale, camera.center[1] - dy / camera.scale),
    };
  }
  protected zoomed(camera: Camera, factor: number, anchor: Point, viewport: kit.Viewport): Camera {
    const zoomed = kit.zoomCamera(camera2d(camera), factor, anchor, viewport);
    return {
      ...camera,
      center: point(zoomed.center[0], zoomed.center[1]),
      scale: Math.max(1e-12, Math.min(1e12, zoomed.scale[0])),
    };
  }
  protected position(item: DiagramItem): Point | null {
    const p = this.shown;
    const at = p?.picking.locate(item);
    return p && at ? kit.cameraPoint(p.camera, at, p.viewport) : null;
  }
  protected identify(item: DiagramItem): string {
    return itemKey(item);
  }
  protected accept(item: DiagramItem): void {
    if (
      !item ||
      typeof item.id !== 'string' ||
      (item.kind !== 'group' &&
        (!KINDS.has(item.kind) ||
          typeof item.type !== 'string' ||
          (item.kind === 'port' && typeof item.port !== 'string')))
    )
      fail('Invalid diagram item');
  }
  protected contains(item: DiagramItem): boolean {
    return this.shown?.picking.has(item) ?? false;
  }
  protected hits(p: Point, radiusPx: number): readonly DiagramHit[] {
    const shown = this.shown;
    if (!shown || !inside(p, shown.viewport)) return [];
    return shown.picking.hit(
      p,
      shown.camera,
      shown.viewport,
      radiusPx,
      portsShown(this.style, shown.camera),
    );
  }
  protected compileShade(shade: Shade | null, format: GPUTextureFormat): Promise<unknown> {
    return this.painter.pipelines(format, this.style.msaa, shade);
  }
  protected listen(
    canvas: HTMLCanvasElement,
    input: kit.CanvasInput,
    mode: NonNullable<ViewInput['mode']>,
  ): () => void {
    const gestures = listen(
      canvas,
      input,
      mode,
      (this.config.input ?? {}) as DiagramInput,
      this.controls,
    );
    this.gestures = gestures;
    return () => {
      gestures.detach();
      if (this.gestures === gestures) this.gestures = undefined;
    };
  }
  protected key(event: KeyboardEvent): boolean {
    return this.gestures?.key(event) ?? false;
  }
  protected cancel(): boolean {
    return this.gestures?.cancel() ?? false;
  }

  protected check(config: DiagramConfig): void {
    super.check(config);
    this.resolved = resolve(config);
  }
  protected configure(previous: DiagramConfig, next: DiagramConfig, options: SetOptions): void {
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
      this.sampled = sampled(this.data);
      this.reread(animate);
      this.pruneSelection();
    }
    if (previous.layout !== next.layout) {
      this.layout = resolved.layout;
      this.reread(animate);
      this.relayout = true;
    }
    const before = this.style;
    this.style = resolveStyle(next, this.viewStyle);
    const changed = (Object.keys(this.style) as (keyof Style)[]).filter((key) => {
      const a = this.style[key],
        b = before[key];
      return Array.isArray(a) && Array.isArray(b)
        ? a.length !== b.length || a.some((v, i) => v !== b[i])
        : a !== b;
    });
    if (changed.some((key) => !UNIFORMS.has(key))) this.reread(false);
    this.invalidate();
  }
  protected get animating(): boolean {
    return (
      !this.closed &&
      (super.animating ||
        !!this.sceneTransition ||
        this.shadeAnimating ||
        (this.flowing && !this.reducedMotion))
    );
  }

  private reread(animate: boolean): void {
    this.transitionRequested = animate;
    this.sceneTransition = undefined;
    this.revision++;
    this.drag = undefined;
  }
  /** Draw dragged vertices offset from their accepted positions, or stop with null. */
  private preview(items: readonly DiagramItem[], delta: Point | null): void {
    if (this.defer('preview', () => this.preview(items, delta))) return;
    if (this.sceneTransition) this.interruptedTransition = true;
    if (!delta && this.interruptedTransition) {
      // The drag starts from what was shown; cancellation must reread accepted positions.
      this.stable = this.stable ? { ...this.stable, revision: -1 } : undefined;
      this.interruptedTransition = false;
    }
    this.sceneTransition = undefined;
    this.transitionRequested = false;
    this.drag = delta ? { keys: this.movingKeys(items), delta } : undefined;
    this.invalidate();
  }
  private movingKeys(items: readonly DiagramItem[]): Set<string> {
    const keys = new Set(items.map(itemKey));
    const scene = this.stable?.scene ?? this.shown?.scene;
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
    const scene = this.stable?.scene ?? this.shown?.scene;
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
    const work = new kit.Work(frame.signal, this.limits.layoutMs),
      revision = this.revision,
      style = this.style,
      data = this.data,
      motion = !this.reducedMotion,
      at = this.sampled ? frame.at : undefined;
    const base = this.stable ?? this.shown;
    let scene: Scene, picking: Picking;
    if (
      this.sceneTransition &&
      (this.sceneTransition.revision !== revision || this.sceneTransition.at !== at)
    )
      this.sceneTransition = undefined;
    const transition = this.sceneTransition;
    const transitioning =
      transition && transition.revision === revision && transition.at === at && !this.drag;
    const cached = base && base.revision === revision && base.at === at && !this.drag;
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
          frame.reader,
          style,
          this.limits,
          (input, request) => this.gpu.measureText(input, request),
          work,
        );
        await place(
          scene,
          this.layout,
          style.gridPitch,
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
      await geometry(scene, style, this.limits, frame.signal, base?.scene, work);
      picking = new Picking(scene, this.limits.pickingBytes);
      const scenes = new Set([
        scene,
        ...(this.stable ? [this.stable.scene] : []),
        ...(this.shown ? [this.shown.scene] : []),
      ]);
      const indices = new Set([
        picking,
        ...(this.stable ? [this.stable.picking] : []),
        ...(this.shown ? [this.shown.picking] : []),
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
      motion &&
      style.animationMs > 0 &&
      scene.vertices.length <= style.animationMaxVertices &&
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
          at,
          start: frame.timeMs,
        };
    }
    this.transitionRequested = false;
    const movement = this.sceneTransition;
    let easing = false;
    if (
      movement &&
      movement.revision === revision &&
      movement.at === at &&
      motion &&
      style.animationMs > 0
    ) {
      const t = Math.min(1, Math.max(0, (frame.timeMs - movement.start) / style.animationMs));
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
        easing = true;
        try {
          await geometry(scene, style, this.limits, frame.signal, base?.scene, work);
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
          easing = false;
        }
      }
    }
    frame.signal.throwIfAborted();
    this.live();
    this.preparing = { scene, picking };
    let camera: Camera;
    try {
      camera = await this.frameCamera(frame);
    } finally {
      this.preparing = undefined;
    }
    const drawn = camera2d(camera),
      viewport = frame.viewport,
      found = picking,
      ports = portsShown(style, drawn);
    const hover = this.hoverFrame(
      frame,
      (p, radius, { check }) =>
        inside(p, viewport) ? found.nearest(p, drawn, viewport, radius, ports, check) : null,
      !!this.drag || easing,
    );
    const paint = await this.painter.prepare(frame, {
      scene,
      style,
      camera: drawn,
      selection: this.selection,
      hover,
      shade: this.shade,
      pointer: this.pointerPoint,
      overlay: this.overlay,
      motion,
    });
    this.shadeAnimating = this.painter.animating;
    work.check();
    this.live();
    const abort = () => {
      if (this.staged === candidate) this.staged = undefined;
    };
    const candidate: Staged = {
      scene,
      picking,
      camera: drawn,
      viewport,
      revision: this.drag ? -1 : revision,
      at,
      paint,
      off: () => frame.signal.removeEventListener('abort', abort),
    };
    frame.signal.addEventListener('abort', abort, { once: true });
    this.staged = candidate;
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
    if (next.scene !== this.shown?.scene)
      this.flowing = next.scene.edges.some((edge) => edge.visible && edge.flow !== 0);
    this.shown = {
      scene: next.scene,
      picking: next.picking,
      camera: next.camera,
      viewport: next.viewport,
      revision: next.revision,
      at: next.at,
    };
    if (next.revision >= 0) this.stable = this.shown;
    if (
      this.sceneTransition &&
      (this.reducedMotion || frame.timeMs >= this.sceneTransition.start + this.style.animationMs)
    )
      this.sceneTransition = undefined;
    this.relayout = false;
    this.counts = {
      vertices: next.scene.vertices.length,
      edges: next.scene.edges.length,
      ends: next.scene.ends,
      geometryBytes: next.scene.bytes,
      drawCalls: next.paint.drawCalls,
    };
  }
  protected release(): void {
    this.staged?.off();
    this.staged = undefined;
    this.shown = undefined;
    this.stable = undefined;
    this.sceneTransition = undefined;
    this.transitionRequested = false;
    this.painter.destroy();
  }
}
