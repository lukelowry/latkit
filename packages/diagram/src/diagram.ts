import { Work, failure, isFailure, sameItem, type FieldValues } from '@latkit/model';
import {
  kit,
  type Gpu,
  type ItemEvents,
  type ItemView,
  type ItemViewConfig,
  type SetOptions,
  type Shade,
  type ViewCamera,
  type ViewInput,
  type ViewStats,
  type FrameInfo,
  type Patch,
  type Viewport,
} from '@latkit/gpu';
import type {
  VertexOptions,
  EdgeOptions,
  DiagramData,
  DiagramItem,
  DiagramPort,
  DiagramRow,
  Point,
  Group,
} from './data.js';
import { FIELD_OPTIONS, diagramData, itemKey, rowOf } from './data.js';
import type { DiagramStyle, Limits } from './options.js';
import {
  DEFAULTS,
  VIEW_DEFAULTS,
  STYLE_EFFECTS,
  checkInput,
  data as checkedData,
  fail,
  positive,
  resolveLimits,
  resolveStyle,
  type Style,
} from './config.js';
import { place, layoutOptions, type Layout, type LayoutOptions } from './layout.js';
import { readScene, sampledStructure, sameStructure } from './read.js';
import { readValues, sampledValues, type Values } from './values.js';
import { dragWires, geometry } from './geometry.js';
import { dragMarks, moved, type DragDraw, type DragMarks } from './drag.js';
import { positions, type Scene } from './scene.js';
import { Picking } from './picking.js';
import { union } from './scene.js';
import { Painter, pipelines, type Paint, type Overlay, type Pipelines } from './painter.js';
import { listen, type Controls, type DiagramInput, type Gestures } from './input.js';
/** A wiring the user drew; the application decides which references change. */
export interface ConnectProposal {
  /** Where the wiring starts: a vertex, or one of its ports. */
  readonly from: DiagramRow | DiagramPort;
  /** What it was dropped on: a vertex or its port, a net to join, or empty canvas. */
  readonly to: DiagramRow | DiagramPort | null;
  /** Dragging a wired input moves it: the net it leaves, and the port leaving it. */
  readonly replaces?: { readonly edge: DiagramRow; readonly end: DiagramPort };
  readonly position: Point;
  readonly point: Point;
}
/** Vertices the user dragged; write the positions to the model to accept them. */
export interface MoveProposal {
  /** Moved positions by vertex type. */
  readonly positions: Readonly<Record<string, FieldValues>>;
  readonly moves: readonly { readonly vertex: DiagramRow; readonly position: Point }[];
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
export interface DiagramEvents extends ItemEvents<DiagramItem, DiagramItem, Camera> {
  /** Double click or Enter. */
  readonly open: DiagramItem;
  readonly connect: ConnectProposal;
  readonly move: MoveProposal;
  /** Delete or Backspace in edit mode: the selected vertex and edge rows. */
  readonly delete: readonly DiagramRow[];
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
  DiagramItem,
  Camera,
  DiagramEvents
> {
  /** `animate` eases vertices to new positions and the camera to a new place. */
  set(patch: Patch<DiagramConfig, Records, Merged>, options?: SetOptions): void;
  /** The item, its wires, and what they join. */
  neighborhood(item: DiagramItem): readonly DiagramItem[];
  stats(): DiagramStats;
}
/** Draw a model as a block diagram: vertices, ports, wires, and groups, on a canvas or offscreen. */
export function createDiagram(gpu: Gpu, config: DiagramConfig): Diagram {
  return new DiagramView(gpu, config);
}
interface Presented {
  readonly values: Values;
  readonly valueData: DiagramData;
  readonly valueAt?: number;
  readonly edgeWidthPx: number;
  readonly ports: boolean;
  readonly scene: Scene;
  readonly picking: Picking;
  readonly camera: kit.Camera2D;
  readonly viewport: Viewport;
  /** The scene's revision, or -1 when the next frame must read it again. */
  readonly revision: number;
  readonly structureRevision: number;
  readonly at?: number;
  /** A drag drawn over the scene, which `locate` follows. */
  readonly drag?: DragDraw;
}
/** A prepared frame: what it shows, and what it draws. */
interface Staged extends Presented {
  readonly paint: Paint;
}
/** What a config means to the diagram: its data, limits, layout, and style. */
interface Resolved {
  readonly config: DiagramConfig;
  readonly data: DiagramData;
  /** Whether the scene reads sampled fields; otherwise it is the same at every coordinate. */
  readonly sampled: boolean;
  readonly sampledValues: boolean;
  readonly limits: Required<Limits>;
  readonly layout: Required<LayoutOptions>;
  readonly style: Style;
}
function point(x: number, y: number): Point {
  return Object.freeze([x, y]) as unknown as Point;
}
const DEFAULT_CAMERA: Camera = Object.freeze({ center: point(0, 0), scale: 1, fit: true });
function camera2d(camera: Camera): kit.Camera2D {
  return { center: camera.center, scale: [camera.scale, camera.scale], yDirection: 'down' };
}
function inside(p: Point, viewport: Viewport): boolean {
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
    DiagramItem,
    DiagramItem,
    Camera,
    DiagramEvents,
    Resolved,
    Staged,
    Pipelines,
    Records,
    Merged
  >
  implements Diagram
{
  private readonly painter: Painter;
  private revision = 0;
  private structureRevision = 0;
  /** The latest drawn frame: what pick, locate, and selection see. */
  private shown?: Presented;
  /** The latest drawn frame of accepted positions, which drags start from. */
  private stable?: Presented;
  private overlay: Overlay | null = null;
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
  /** A drag in progress: the items it started with, what they move, and how far. */
  private drag?: {
    readonly items: readonly DiagramItem[];
    readonly keys: ReadonlySet<string>;
    readonly delta: Point;
  };
  /** What the drag moves in the scene it draws over, found once per drag and scene. */
  private dragged?: {
    readonly keys: ReadonlySet<string>;
    readonly scene: Scene;
    readonly marks: DragMarks;
  };
  private interruptedTransition = false;
  private relayout = false;
  private gestures?: Gestures;
  private readonly controls: Controls = {
    emit: (event, value) => this.emit(event, value),
    selection: () => this.selection,
    choose: (items) => this.choose(items),
    click: (p, modifiers, touch) =>
      void this.click(p, modifiers, { touch }).catch((error: unknown) => this.fail(error)),
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
    reveal: (item) => this.reveal(item),
    invalidated: (listener) => this.onInvalidate(listener),
  };
  constructor(gpu: Gpu, config: DiagramConfig) {
    super(gpu, config, {
      name: 'diagram',
      style: VIEW_DEFAULTS,
      records: ['vertices', 'edges', 'groups'],
      merged: ['camera', 'input', 'limits', 'layout'],
      shorthands: { layout: 'algorithm' },
      fields: FIELD_OPTIONS,
      nested: ['ports'],
      options: Object.keys(DEFAULTS),
      framed: ['center', 'scale'],
      modes: ['navigate', 'edit', 'inspect', 'none'],
      // Presses drag, wire, and marquee here; the gestures select through `click`.
      clicks: false,
    });
    this.painter = new Painter(gpu);
    this.start();
  }
  private get data(): DiagramData {
    return this.resolved.data;
  }
  private get style(): Style {
    return this.resolved.style;
  }
  private get limits(): Required<Limits> {
    return this.resolved.limits;
  }

  neighborhood(item: DiagramItem): readonly DiagramItem[] {
    const scene = this.shown?.scene;
    if (!scene) return [];
    const result = new Map<string, DiagramItem>([[itemKey(item), item]]),
      vertices = new Set<number>();
    scene.vertices.forEach((n, i) => {
      if (
        item.kind === 'group' ? n.group === item.id : item.kind !== 'edge' && sameItem(n.hit, item)
      )
        vertices.add(i);
    });
    for (const e of scene.edges)
      if (
        (item.kind === 'edge' && sameItem(item, e.hit)) ||
        e.ends.some((end) => vertices.has(end.vertex))
      ) {
        result.set(itemKey(e.hit), rowOf(e.hit));
        for (const end of e.ends) {
          const n = scene.vertices[end.vertex];
          result.set(itemKey(n.hit), rowOf(n.hit));
        }
      }
    for (const i of vertices)
      result.set(itemKey(scene.vertices[i].hit), rowOf(scene.vertices[i].hit));
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
    const { center, scale, fit } = camera;
    if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite))
      fail('Invalid camera center');
    positive(scale, 'camera scale');
    if (typeof fit !== 'boolean') fail('Invalid camera fit');
    return Object.freeze({ center: point(center[0], center[1]), scale, fit });
  }
  /** The camera that frames items in a scene, or the whole scene; undefined before anything draws. */
  private framing(
    scene: Scene,
    picking: Picking,
    items: readonly DiagramItem[] | undefined,
    viewport: Viewport,
  ): Partial<Camera> | undefined {
    const boxes = items ? picking.bounds(items) : [];
    if (!boxes.length && !picking.drawn) return undefined;
    const fitted = kit.fitCamera(
      boxes.length ? union(boxes) : scene.bounds,
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
  protected zoomed(camera: Camera, factor: number, anchor: Point, viewport: Viewport): Camera {
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
    if (!p || !at) return null;
    // A dragged item draws where the drag has taken it.
    const drag = p.drag?.marks.moving.has(itemKey(item)) ? p.drag.delta : undefined;
    return kit.cameraPoint(p.camera, drag ? [at[0] + drag[0], at[1] + drag[1]] : at, p.viewport);
  }
  protected identify(item: DiagramItem): string {
    return itemKey(item);
  }
  protected accept(item: DiagramItem): void {
    if (
      !item ||
      (item.kind === 'group'
        ? typeof item.id !== 'string'
        : !KINDS.has(item.kind) ||
          typeof item.index?.type !== 'string' ||
          !Number.isSafeInteger(item.row) ||
          (item.kind === 'port' && typeof item.port !== 'string'))
    )
      fail('Invalid diagram item');
  }
  protected contains(item: DiagramItem): boolean {
    return this.shown?.picking.has(item) ?? false;
  }
  protected hits(p: Point, radiusPx: number): readonly DiagramItem[] {
    const shown = this.shown;
    if (!shown || !inside(p, shown.viewport)) return [];
    return shown.picking.hit(
      p,
      shown.camera,
      shown.viewport,
      radiusPx,
      shown.ports,
      undefined,
      shown,
    );
  }
  protected pipelines(format: GPUTextureFormat, msaa: 1 | 4, shade: Shade): Promise<Pipelines> {
    return pipelines(this.gpu, format, msaa, shade.wgsl);
  }
  protected checkInput(input: DiagramInput): void {
    super.checkInput(checkInput(input));
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

  protected resolve(config: DiagramConfig): Resolved {
    const data = checkedData(diagramData(config));
    return {
      config,
      data,
      sampled: sampledStructure(data),
      sampledValues: sampledValues(data),
      limits: resolveLimits(config.limits),
      layout: layoutOptions(config.layout),
      style: resolveStyle(config, this.sharedStyle(config)),
    };
  }
  protected configure(resolved: Resolved, before: Resolved, options: SetOptions): void {
    const { config: next } = resolved,
      { config: previous } = before;
    const animate = options.animate === true;
    if (!sameStructure(before.data, resolved.data) || previous.limits !== next.limits) {
      this.reread(animate);
      this.pruneSelection();
    }
    if (previous.layout !== next.layout) {
      this.reread(animate);
      this.relayout = true;
    }
    const changed = (Object.keys(resolved.style) as (keyof Style)[]).filter((key) => {
      const a = resolved.style[key],
        b = before.style[key];
      return Array.isArray(a) && Array.isArray(b)
        ? a.length !== b.length || a.some((v, i) => v !== b[i])
        : a !== b;
    });
    const effects = new Set(changed.map((key) => STYLE_EFFECTS[key]));
    if (effects.has('scene')) this.reread(false);
    else if (effects.has('route')) {
      this.revision++;
      this.sceneTransition = undefined;
      this.drag = undefined;
    }
    this.invalidate();
  }
  protected get animating(): boolean {
    return (
      !this.closed &&
      (super.animating || !!this.sceneTransition || (this.flowing && !this.reducedMotion))
    );
  }

  private reread(animate: boolean): void {
    this.transitionRequested = animate;
    this.sceneTransition = undefined;
    this.revision++;
    this.structureRevision++;
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
    const drag = this.drag;
    this.drag = delta
      ? { items, keys: drag?.items === items ? drag.keys : this.movingKeys(items), delta }
      : undefined;
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
        vertex: rowOf(vertices[i].hit),
        position: [vertices[i].x, vertices[i].y],
      })),
    };
  }
  protected async prepare(frame: kit.Preparation): Promise<Staged> {
    this.live();
    // Compile while the scene reads.
    const compiling = this.framePipelines(frame);
    void compiling.catch(() => {});
    const { data, style, limits, layout } = this.resolved,
      work = new Work(frame.signal, limits.layoutMs),
      revision = this.revision,
      structureRevision = this.structureRevision,
      motion = !this.reducedMotion,
      at = this.resolved.sampled ? frame.at : undefined;
    const base = this.stable ?? this.shown,
      // An exported frame draws transitions at their targets and changes none of them.
      presented = frame.presented;
    let scene: Scene, picking: Picking;
    if (
      presented &&
      this.sceneTransition &&
      (this.sceneTransition.revision !== revision || this.sceneTransition.at !== at)
    )
      this.sceneTransition = undefined;
    const transition = this.sceneTransition;
    const transitioning =
      transition && transition.revision === revision && transition.at === at && !this.drag;
    const cached = base && base.revision === revision && base.at === at && !this.drag;
    let drag: DragDraw | null = null,
      drawnAt = at;
    if (this.drag && base && base.revision === revision) {
      // A drag draws over the accepted scene, even while the coordinate plays on; only what it
      // moves is placed and routed again.
      scene = base.scene;
      picking = base.picking;
      drawnAt = base.at;
      drag = this.dragDraw(scene, this.drag, style, frame.signal);
    } else if (transitioning) {
      scene = transition.target;
      picking = transition.picking;
    } else if (cached) {
      scene = base.scene;
      picking = base.picking;
    } else {
      if (
        base &&
        base.revision >= 0 &&
        base.structureRevision === structureRevision &&
        base.at === at
      ) {
        scene = {
          ...base.scene,
          vertices: base.scene.vertices.map((vertex) => ({
            ...vertex,
            ports: vertex.ports.map((port) => ({ ...port })),
          })),
          edges: base.scene.edges.map((edge) => ({ ...edge })),
          groups: base.scene.groups.map((group) => ({ ...group })),
        };
      } else {
        scene = await readScene(
          data,
          frame.reader,
          style,
          limits,
          (input) => this.gpu.layoutText(input, { signal: work.signal }),
          work,
        );
        await place(
          scene,
          layout,
          style.gridPitch,
          frame.signal,
          this.relayout ? undefined : base?.scene,
          work,
        );
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
        throw failure('resource-limit', 'Retained picking exceeds budget');
      if ([...scenes].reduce((n, value) => n + value.bytes, 0) > this.limits.geometryBytes)
        throw failure('resource-limit', 'Retained geometry exceeds budget');
    }
    if (
      presented &&
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
    if (presented) this.transitionRequested = false;
    const movement = this.sceneTransition;
    let easing = false;
    if (
      presented &&
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
            throw failure('resource-limit', 'Transition exceeds retained budgets');
        } catch (error) {
          frame.signal.throwIfAborted();
          if (!isFailure(error) || !['invalid-input', 'resource-limit'].includes(error.code))
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
    const valueAt = this.resolved.sampledValues
      ? this.drag
        ? base?.valueAt
        : frame.at
      : undefined;
    const valueData = this.drag && base ? base.valueData : data;
    const values =
      base &&
      (drag ||
        (base.structureRevision === structureRevision &&
          base.at === at &&
          base.valueAt === valueAt &&
          base.valueData.source === valueData.source &&
          base.valueData.vertices === valueData.vertices &&
          base.valueData.edges === valueData.edges))
        ? base.values
        : await readValues(scene, valueData, frame.reader, work);
    const retainedValues = new Set([
      values,
      ...(this.stable ? [this.stable.values] : []),
      ...(this.shown ? [this.shown.values] : []),
    ]);
    const retainedScenes = new Set([
      scene,
      ...(this.stable ? [this.stable.scene] : []),
      ...(this.shown ? [this.shown.scene] : []),
    ]);
    if (
      [...retainedValues].reduce((sum, value) => sum + value.bytes, 0) +
        [...retainedScenes].reduce((sum, value) => sum + value.bytes, 0) >
      limits.geometryBytes
    )
      throw failure('resource-limit', 'Retained geometry and values exceed budget');
    const hitStyle = { values, edgeWidthPx: style.edgeWidthPx };
    const framed = scene,
      found = picking;
    const camera = await this.frameCamera(frame, (items, _, viewport) =>
      this.framing(framed, found, items, viewport),
    );
    const drawn = camera2d(camera),
      viewport = frame.viewport,
      ports = portsShown(style, drawn);
    const hover = this.hoverFrame(
      frame,
      (p, radius, { check }) =>
        inside(p, viewport)
          ? found.nearest(p, drawn, viewport, radius, ports, check, hitStyle)
          : null,
      !!this.drag || easing,
    );
    const paint = await this.painter.prepare(frame, {
      scene,
      values,
      style,
      camera: drawn,
      selection: this.selection,
      hover,
      pipelines: await work.wait(compiling),
      shade: this.shadeFrame(frame),
      overlay: this.overlay,
      drag,
      motion,
    });
    work.check();
    this.live();
    return {
      scene,
      values,
      valueData,
      valueAt,
      edgeWidthPx: style.edgeWidthPx,
      ports,
      picking,
      camera: drawn,
      viewport,
      revision,
      structureRevision,
      at: drawnAt,
      drag: drag ?? undefined,
      paint,
    };
  }
  /** The drag drawn over a scene: what it moves, found once, and the wires it reroutes. */
  private dragDraw(
    scene: Scene,
    drag: { readonly keys: ReadonlySet<string>; readonly delta: Point },
    style: Style,
    signal: AbortSignal,
  ): DragDraw {
    let dragged = this.dragged;
    if (dragged?.keys !== drag.keys || dragged.scene !== scene)
      this.dragged = dragged = { keys: drag.keys, scene, marks: dragMarks(scene, drag.keys) };
    const { marks } = dragged;
    return {
      marks,
      delta: drag.delta,
      wires: dragWires(scene, marks.edges, moved(scene, marks, drag.delta), style, signal),
    };
  }
  protected encode(frame: kit.Encoding, staged: Staged): void {
    this.live();
    this.painter.encode(frame, staged.paint);
  }
  protected submitted(frame: FrameInfo, next: Staged): void {
    if (this.closed) return;
    // An exported frame leaves what pick, locate, drags, and layout start from.
    if (!frame.presented) return;
    this.flowing = next.values.flowing;
    this.shown = {
      values: next.values,
      valueData: next.valueData,
      valueAt: next.valueAt,
      edgeWidthPx: next.edgeWidthPx,
      ports: next.ports,
      scene: next.scene,
      picking: next.picking,
      camera: next.camera,
      viewport: next.viewport,
      revision: next.revision,
      structureRevision: next.structureRevision,
      at: next.at,
      drag: next.drag,
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
      geometryBytes: next.scene.bytes + next.values.bytes,
      drawCalls: next.paint.drawCalls,
    };
  }
  protected release(): void {
    this.shown = undefined;
    this.stable = undefined;
    this.sceneTransition = undefined;
    this.transitionRequested = false;
    this.painter.destroy();
  }
}
