/**
 * Views: a scene drawn from the given sources. A view's state is a set of properties, and setting
 * one emits no event. When the user changes that state, the view emits an event named after the
 * property. Queries are methods, answered by the frames that draw the view.
 */

import type * as bindings from '../pkg/latkit.js';
import { Snapshot, sourceOf, type Source } from './data.js';
import type { Camera, Fit, Row, Rows, Scene } from './inputs.js';
import { Handle, inner, thrown, waited, type LatkitError, type Wait } from './internal.js';
import type { Failure, Hit, Stats, ViewEvent, Waiting } from './outputs.js';
import { Patch } from './patch.js';

/**
 * The events a view emits, by type, mapped to each event's detail. Intents (`click`, `open`,
 * `menu`, `drag`, `connect`, `delete`) are emitted once each, in the order the user acted. Changes
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
 * A scene drawn from its sources; created by `Gpu.view()`. A canvas shows it and passes it input,
 * and a `Shot` draws it into pictures. Destroying it rejects its unanswered queries; a canvas
 * showing it keeps its last frame.
 */
export class View extends Handle {
  #listeners = new Map<keyof ViewEvents, Set<(event: never) => void>>();
  #scene: Scene;
  #sources: readonly Source[] = [];
  #released: () => void;

  private constructor(device: bindings.Gpu, scene: Scene, released: () => void) {
    // The view sends events once it exists, so the callback finds it through `told`.
    const told: { view?: View } = {};
    const tell = (json: string) => {
      if (told.view) told.view.#tell(json);
    };
    super(device.view(JSON.stringify(scene), tell), 'View');
    told.view = this;
    this.#scene = scene;
    this.#released = released;
  }

  /** @internal Creates a view of `scene` on `device`; `released` is called once it is destroyed. */
  static made(device: bindings.Gpu, scene: Scene, released: () => void): View {
    return new View(device, scene, released);
  }

  /**
   * The scene drawn. Marks that match a mark of the previous scene by kind, dataset, table, and
   * name keep their state and ease to their new options. An invalid scene leaves the current one.
   */
  get scene(): Scene {
    return this.#scene;
  }

  set scene(scene: Scene) {
    view(this).setScene(JSON.stringify(scene));
    this.#scene = scene;
  }

  /**
   * The datasets the view draws, matched to marks by dataset name, which must be unique. The view
   * draws a `Data` at its latest version, from the frame after each patch; a `Snapshot` unchanged;
   * and `Tiles` as the pieces it needs. A mark whose dataset no longer fits it draws nothing; it is
   * listed in `failures`, and the next frame emits an `error` event.
   */
  get sources(): readonly Source[] {
    return this.#sources;
  }

  set sources(sources: readonly Source[]) {
    view(this).setSources(sources.map(sourceOf));
    this.#sources = [...sources];
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
   * Where the view looks. Setting it moves the camera at once; use {@link View.fly} to ease. A
   * camera of the wrong kind for the space, such as a plot camera on a map, is ignored.
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
   * Degrees per second the camera turns about its center on a map or plane; 0 stops it. A diagram
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

  /** The row under the pointer, or the row keyboard navigation moved to; `null` if none. */
  get hovered(): Hit | null {
    return JSON.parse(view(this).hovered) as Hit | null;
  }

  /**
   * The kinds of pending work that kept the last frame from being complete; empty when it was
   * complete. See {@link Waiting}.
   */
  get waiting(): Waiting {
    return JSON.parse(view(this).waiting) as Waiting;
  }

  /** Whether the last frame was complete, with nothing in `waiting` pending. Shots wait for it. */
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
   * Frames what `fit` names, every row by default, keeping pitch and bearing. It takes effect on
   * the next frame, or a frame or two later when the extent must be measured on the GPU.
   */
  fit(fit: Fit = 'all'): void {
    view(this).fit(JSON.stringify(fit));
  }

  /**
   * Eases the camera to `camera` over twice the scene's ease time, or at once when motion is
   * reduced. A camera of the wrong kind for the space is ignored.
   */
  fly(camera: Camera): void {
    view(this).fly(JSON.stringify(camera));
  }

  /**
   * Projects `position` to a point on screen with the current camera, for anchoring HTML overlays;
   * `null` when it is behind the camera.
   */
  screen(position: Position): Point | null {
    const point = view(this).screen(Float64Array.from(position));
    return point ? [point[0]!, point[1]!] : null;
  }

  /**
   * The position on the ground under screen point `point`: at elevation 0 on a plane, on the map or
   * globe on the earth, the values there on a plot. `null` where the point looks past the ground.
   */
  position(point: Point): Position | null {
    const position = view(this).position(Float32Array.from(point));
    return position ? [position[0]!, position[1]!, position[2]!] : null;
  }

  /**
   * Resolves to where `row` is on screen once a frame draws the view, or `null` when no mark draws
   * it in view. A diagram's vertices resolve at once.
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
      /** How near, in CSS pixels; 0 by default. */
      radius?: number;
    } & Wait = {},
  ): Promise<Hit[]> {
    const hits = view(this).pick(Float32Array.from(point), options.radius ?? 0);
    return JSON.parse(await waited<string>(hits, options, 'picking')) as Hit[];
  }

  /**
   * The rows connected to `row`, one set per table: a vertex's neighbors across edges and nets, or
   * an edge's or a net's vertices. The cost is proportional to the row's degree.
   */
  neighbors(row: Row): Rows[] {
    return JSON.parse(view(this).neighbors(JSON.stringify(row))) as Rows[];
  }

  /**
   * Lays out every vertex row without a position again, and resolves to one patch per dataset that
   * writes each row's place into its mark's position fields; applied, the places become part of
   * the data. Marks whose position is not read from fields are left out.
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
   * The version of dataset `name` the view draws, or `undefined` if it draws none of that name: the
   * latest version of a `Data` the view has taken, a given snapshot, or the pieces of `Tiles`
   * fetched for its camera.
   */
  snapshot(name: string): Snapshot | undefined {
    const snapshot = view(this).snapshot(name);
    return snapshot ? Snapshot.made(snapshot) : undefined;
  }

  /**
   * Calls `listener` with each event of `type` emitted while it is registered, and returns a
   * function that removes it. Past events are not replayed; read the current state from the
   * property a change event is named after.
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
      const listeners = this.#listeners.get(told.type) as Set<(event: unknown) => void> | undefined;
      if (!listeners?.size) continue;
      const event = told.type === 'error' ? thrown(told.detail) : told.detail;
      for (const listener of listeners) listener(event);
    }
  }

  /** @internal Drops the listeners and tells the GPU the view is gone. */
  protected override freeing(): void {
    for (const listeners of this.#listeners.values()) listeners.clear();
    this.#listeners.clear();
    this.#released();
  }
}

function view(owner: View): bindings.View {
  return inner<bindings.View>(owner);
}

/** @internal Returns a new bindings handle to the view, for a canvas to show or a shot to draw. */
export function handleOf(owner: View): bindings.Handle {
  return view(owner).handle();
}
