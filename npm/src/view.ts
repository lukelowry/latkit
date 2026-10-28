/**
 * Views: a scene drawn from its datasets on a canvas. A view's state is a set of properties.
 * Setting one emits no event. When the user changes one, the view emits an event named after the
 * property. Queries are methods, answered by the frames that draw the view.
 */

import type * as bindings from '../pkg/latkit.js';
import type { Canvas, Rect } from './canvas.js';
import { Snapshot, sourceOf, Table, type Source } from './data.js';
import { device, Gpu } from './gpu.js';
import type { Camera, Fit, Row, Rows, Scene } from './inputs.js';
import { Handle, inner, onStop, thrown, waited, type LatkitError, type Wait } from './internal.js';
import type { Failure, Hit, Stats, ViewEvent, Waiting } from './outputs.js';
import { Patch } from './patch.js';

/** The region covering a whole canvas or picture. */
const WHOLE: Rect = [0, 0, 1, 1];

/** @internal Returns the canvas showing `view`, if any. */
export let canvasOf: (view: View) => Canvas | undefined;

/**
 * The events a view emits, mapping each type to its detail. Intents (`click`, `open`, `menu`,
 * `drag`, `connect`, `delete`) are emitted once each, in the order the user acted. Changes
 * (`hovered`, `selection`, `camera`, `waiting`) are named after the property that changed and carry
 * only its latest value. An `error` event's detail is a {@link LatkitError}. Setters emit nothing,
 * so events report only what the application did not do itself.
 */
export type ViewEvents = {
  [E in ViewEvent as E['type']]: E extends { type: 'error' } ? LatkitError : E['detail'];
};

/** CSS pixels kept clear at the top, right, bottom, and left. */
export type Insets = [top: number, right: number, bottom: number, left: number];

/** A point on screen, in CSS pixels from the view's top left corner. */
export type Point = [x: number, y: number];

/**
 * A position in the space's coordinates: x, y, and elevation. On the earth, x and y are longitude
 * and latitude; on a plot, the axis coordinate and the value.
 */
export type Position = [x: number, y: number, elevation: number];

/**
 * A scene drawn from its datasets on a canvas and into pictures. Create one with
 * {@link View.create}. The canvas passes it pointer, wheel, and key input, and a `Shot` draws it
 * into pictures. Destroying a view rejects its unanswered queries, and its canvas keeps the last
 * frame.
 *
 * ```ts
 * const grid = new Data('grid').set('Bus', [1, 2], { x: [0, 30], y: [0, 20], kv: [230, 115] });
 * const view = await View.create(canvas, {
 *   space: 'plane',
 *   marks: [{ vertices: grid.table('Bus'), position: ['$x', '$y'], color: field('kv').colormap('viridis') }],
 * });
 * ```
 */
export class View extends Handle {
  static {
    canvasOf = (view) => view.#canvas;
  }

  #listeners = new Map<keyof ViewEvents, Set<(event: never) => void>>();
  /** Stops listening for latkit stopping. */
  #unstop: () => void;
  #gpu: Gpu;
  #canvas: Canvas | undefined;
  #region: Rect;
  #scene: Scene;
  /** The datasets of the tables the scene names. */
  #tables: readonly Source[];
  #sources: readonly Source[] = [];

  private constructor(gpu: Gpu, scene: Scene, region: Rect) {
    // The view sends events once it exists, so the callback finds it through `told`.
    const told: { view?: View } = {};
    const tell = (json: string) => {
      if (told.view) told.view.#tell(json);
    };
    const { json, tables } = encoded(scene);
    super(device(gpu).view(json, tell), 'View');
    told.view = this;
    this.#unstop = onStop((error) => this.#emit('error', error));
    this.#gpu = gpu;
    this.#region = region;
    this.#scene = scene;
    this.#tables = tables;
  }

  /**
   * Creates a view that draws `scene` on `canvas`, in `options.region`, over any views already
   * there. With a `null` canvas, the view draws only into pictures. The view loads every dataset
   * its scene uses. Unless given a camera, it frames everything when it first draws.
   */
  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas | null,
    scene: Scene,
    options: {
      /** The part of the canvas, and of pictures, that the view draws in. Defaults to all of it. */
      region?: Rect;
      /** Where the view looks first. Without one, it frames everything drawn. */
      camera?: Camera;
      /** Datasets to draw besides those the scene uses. See {@link View.sources}. */
      sources?: readonly Source[];
      /**
       * The GPU that draws the view. Defaults to the first `Gpu` created, creating one if needed.
       */
      gpu?: Gpu;
      /**
       * Pixels per CSS pixel of an `OffscreenCanvas`. Defaults to 1. The first view on the canvas
       * sets it.
       */
      pixelRatio?: number;
    } = {},
  ): Promise<View> {
    const gpu = options.gpu ?? (await Gpu.shared());
    const view = new View(gpu, scene, options.region ?? WHOLE);
    try {
      view.sources = options.sources ?? [];
      if (options.camera) view.camera = options.camera;
      else view.fit();
      view.#canvas = gpu.adopt(view, canvas, options.pixelRatio);
    } catch (error) {
      view.destroy();
      throw error;
    }
    return view;
  }

  /** The GPU that draws the view. */
  get gpu(): Gpu {
    return this.#gpu;
  }

  /**
   * The part of its canvas, and of pictures, that the view draws in: `[x, y, width, height]` in
   * fractions, from the top left. Views on one canvas draw in the order they were created.
   */
  get region(): Rect {
    return this.#region;
  }

  set region(region: Rect) {
    this.#region = region;
    this.#canvas?.relayout();
  }

  /**
   * The scene drawn. A mark that matches one in the previous scene by kind, dataset, table, and
   * name keeps its state and eases to its new options. An invalid scene leaves the current one in
   * place.
   */
  get scene(): Scene {
    return this.#scene;
  }

  set scene(scene: Scene) {
    const { json, tables } = encoded(scene);
    const changed =
      tables.length !== this.#tables.length || tables.some((t, i) => t !== this.#tables[i]);
    const drawn = changed ? this.#drawn(tables, this.#sources) : undefined;
    view(this).setScene(json);
    this.#scene = scene;
    this.#tables = tables;
    if (drawn) view(this).setSources(drawn);
  }

  /**
   * Datasets the view draws besides those its scene uses. A source replaces a scene dataset with
   * the same name. A mark whose table is written `[data, table]` draws the source named `data`. The
   * view draws a `Data` at its latest version from the frame after each change, a `Snapshot` as it
   * is, and `Tiles` as the pieces it needs. A mark whose dataset no longer fits it draws nothing.
   * It is listed in `failures`, and the next frame emits an `error` event.
   */
  get sources(): readonly Source[] {
    return this.#sources;
  }

  set sources(sources: readonly Source[]) {
    view(this).setSources(this.#drawn(this.#tables, sources));
    this.#sources = [...sources];
  }

  /**
   * The datasets drawn, as the bindings take them: `sources`, then those of the scene's `tables`
   * that no source replaces by name. Throws an `invalid` error when two datasets share a name.
   */
  #drawn(tables: readonly Source[], sources: readonly Source[]): bindings.Source[] {
    const named = new Set(sources.map((source) => source.name));
    const drawn = [...sources, ...tables.filter((table) => !named.has(table.name))];
    const twice = drawn.find((source, i) => drawn.findIndex((s) => s.name === source.name) !== i);
    if (twice)
      throw thrown({
        code: 'invalid',
        message: `two datasets are named '${twice.name}'`,
        path: 'sources',
      });
    return drawn.map(sourceOf);
  }

  /**
   * The axis coordinate shown, such as a time. Marks read sampled fields at it, interpolating
   * between the frame at or before it and the next, unless an expression uses `step()`.
   */
  get at(): number {
    return view(this).at;
  }

  set at(at: number) {
    view(this).at = at;
  }

  /**
   * Where the view looks. Setting it moves the camera at once, replacing a flight or a fit not yet
   * applied. Use {@link View.fly} to ease. A camera of the wrong kind for the space, such as a plot
   * camera on a map, is ignored.
   *
   * Camera moves stay within the camera's zoom and pan limits. On the earth, the space sets the
   * limits inside the insets, as `Earth` describes. A fit narrows them to 3 zoom levels out and 8
   * in from the box it framed, with the center near that box. When a resize, new insets, or a new
   * space moves the camera back within its limits, a `camera` event reports it.
   */
  get camera(): Camera {
    return JSON.parse(view(this).camera) as Camera;
  }

  set camera(camera: Camera) {
    view(this).setCamera(JSON.stringify(camera));
  }

  /**
   * CSS pixels kept clear at the top, right, bottom, and left, such as where page panels cover the
   * view. The camera centers and fits within the rest.
   */
  get insets(): Insets {
    const [top, right, bottom, left] = view(this).insets;
    return [top!, right!, bottom!, left!];
  }

  set insets(insets: Insets) {
    view(this).insets = Float32Array.from(insets);
  }

  /**
   * Degrees per second the camera turns about its center on a map or plane. 0 stops it. A diagram
   * never turns.
   */
  get orbit(): number {
    return view(this).orbit;
  }

  set orbit(degreesPerSecond: number) {
    view(this).orbit = degreesPerSecond;
  }

  /** The selected rows, one set per table. Setting it selects exactly those rows. */
  get selection(): readonly Rows[] {
    return JSON.parse(view(this).selection) as Rows[];
  }

  set selection(rows: readonly Rows[]) {
    view(this).setSelection(JSON.stringify(rows));
  }

  /** The row under the pointer or the row keyboard navigation moved to, or `null`. */
  get hovered(): Hit | null {
    return JSON.parse(view(this).hovered) as Hit | null;
  }

  /**
   * The kinds of pending work that kept the last frame from being complete. Empty when it was
   * complete. See {@link Waiting}.
   */
  get waiting(): Waiting {
    return JSON.parse(view(this).waiting) as Waiting;
  }

  /** Whether the last frame was complete, with nothing in `waiting`. Shots wait for this. */
  get complete(): boolean {
    return view(this).complete;
  }

  /**
   * An error for each mark that draws nothing because its data no longer fits it, such as a missing
   * table. Each error's `path` names the mark.
   */
  get failures(): readonly LatkitError[] {
    return (JSON.parse(view(this).failures) as Failure[]).map(thrown);
  }

  /** Counts and timings of the view's frames; see {@link Stats}. */
  get stats(): Stats {
    return JSON.parse(view(this).stats) as Stats;
  }

  /** Whether the view needs a frame, because it changed or work it was waiting on arrived. */
  get wantsFrame(): boolean {
    return view(this).wantsFrame;
  }

  /**
   * Frames what `fit` names, keeping pitch and bearing, and replaces any fit not yet applied.
   * Defaults to every row. It applies once the rows have their places (their data streamed, any
   * layout placed them, and they eased there), a frame or two later when the GPU must measure the
   * extent. With nothing drawn to frame, it frames the rows that arrive later. Until a view's first
   * fit applies, it shows only its background. A fit frames a diagram at most at its natural size
   * and the earth at most at zoom 16, which is also where it frames a single point.
   */
  fit(fit: Fit = 'all'): void {
    view(this).fit(JSON.stringify(fit));
  }

  /**
   * Eases the camera to `camera` over `seconds`, or over twice the scene's ease time without it,
   * replacing a fit not yet applied. When motion is reduced, it moves at once. The camera stays
   * within its limits, as {@link View.camera} describes. A camera of the wrong kind for the space is
   * ignored.
   */
  fly(camera: Camera, seconds?: number): void {
    view(this).fly(JSON.stringify(camera), seconds);
  }

  /**
   * Projects `position` to a point on screen with the current camera, for anchoring HTML overlays.
   * Returns `null` when the position is behind the camera.
   */
  screen(position: Position): Point | null {
    const point = view(this).screen(Float64Array.from(position));
    return point ? [point[0]!, point[1]!] : null;
  }

  /**
   * Returns the position on the ground under screen point `point`: at elevation 0 on a plane, on
   * the map or globe on the earth, and the values there on a plot. Returns `null` where the point
   * looks past the ground.
   */
  position(point: Point): Position | null {
    const position = view(this).position(Float32Array.from(point));
    return position ? [position[0]!, position[1]!, position[2]!] : null;
  }

  /**
   * Resolves to where `row` is on screen once a frame draws the view, or to `null` when no mark
   * draws it in view. A diagram's vertices resolve at once.
   */
  screenOf(row: Row, wait: Wait = {}): Promise<Point | null> {
    return waited<Point | null>(view(this).screenOf(JSON.stringify(row)), wait, 'locating a row');
  }

  /**
   * Resolves, once a frame draws the view, to every row of a pickable mark near `point`, nearest
   * first.
   */
  async pick(
    point: Point,
    options: {
      /** How near, in CSS pixels. Defaults to 0. */
      radius?: number;
    } & Wait = {},
  ): Promise<Hit[]> {
    const hits = view(this).pick(Float32Array.from(point), options.radius ?? 0);
    return JSON.parse(await waited<string>(hits, options, 'picking')) as Hit[];
  }

  /**
   * Returns the rows connected to `row`, one set per table: a vertex's neighbors across edges and
   * nets, or the vertices of an edge or net. The cost is proportional to the row's degree.
   */
  neighbors(row: Row): Rows[] {
    return JSON.parse(view(this).neighbors(JSON.stringify(row))) as Rows[];
  }

  /**
   * Lays out again every vertex row that has no position, and resolves to one patch per dataset.
   * Each patch writes each row's place into its mark's position fields, so applying it makes the
   * places part of the data. Marks that don't read their position from fields are left out.
   *
   * ```ts
   * for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
   * ```
   */
  async arrange(wait: Wait = {}): Promise<Patch[]> {
    const frames = await waited<Uint8Array[]>(view(this).arrange(), wait, 'arranging');
    return Promise.all(frames.map((frame) => Patch.read(frame)));
  }

  /**
   * Returns the version of dataset `name` that the view draws, or `undefined` if it draws no
   * dataset by that name. That is the latest version of a `Data` the view has taken, the snapshot
   * it was given, or the pieces of `Tiles` fetched for its camera.
   */
  snapshot(name: string): Snapshot | undefined {
    const snapshot = view(this).snapshot(name);
    return snapshot ? Snapshot.made(snapshot) : undefined;
  }

  /**
   * Calls `listener` with each event of `type` emitted while it is registered. Returns a function
   * that removes it. Past events are not replayed. Read the current state from the property that a
   * change event is named after.
   */
  on<T extends keyof ViewEvents>(type: T, listener: (event: ViewEvents[T]) => void): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Dispatches a JSON batch of the view's events to the listeners of each event's type. */
  #tell(json: string): void {
    if (this.#listeners.size === 0) return;
    for (const told of JSON.parse(json) as ViewEvent[]) {
      if (!this.#listeners.get(told.type)?.size) continue;
      this.#emit(told.type, told.type === 'error' ? thrown(told.detail) : told.detail);
    }
  }

  /** Calls the listeners of `type` with `event`. */
  #emit(type: keyof ViewEvents, event: unknown): void {
    const listeners = this.#listeners.get(type) as Set<(event: unknown) => void> | undefined;
    for (const listener of listeners ?? []) listener(event);
  }

  /** @internal Drops the listeners, and takes the view off its canvas and its GPU. */
  protected override freeing(): void {
    this.#unstop();
    for (const listeners of this.#listeners.values()) listeners.clear();
    this.#listeners.clear();
    this.#canvas?.remove(this);
    this.#canvas = undefined;
    this.#gpu.release(this);
  }
}

function view(owner: View): bindings.View {
  return inner<bindings.View>(owner);
}

/** `scene` as JSON, and the datasets of the tables it names. */
function encoded(scene: Scene): { json: string; tables: Source[] } {
  const tables = new Set<Source>();
  const json = JSON.stringify(scene, function (this: Record<string, unknown>, key, value: unknown) {
    // `value` is what `toJSON` returned. The holder still has the table itself.
    const held = this[key];
    if (held instanceof Table) tables.add(held.source);
    return value;
  });
  return { json, tables: [...tables] };
}

/** @internal Returns a new bindings handle to the view, for a canvas to show or a shot to draw. */
export function handleOf(owner: View): bindings.Handle {
  return view(owner).handle();
}
