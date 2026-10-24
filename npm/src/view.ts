/**
 * Views: a scene drawn from the sources it is given. What a view keeps is a property, read and set
 * alike, setters silent; what the user changes is told by an event named like its property; what the
 * view is asked is a method, answered by the frames that draw it.
 */

import type * as bindings from '../pkg/latkit.js';
import { snapshotOf, sourceOf, type Snapshot, type Source } from './data.js';
import type { Camera, Fit, Row, Rows, Scene } from './inputs.js';
import { hold, inner, release, thrown, waited, type LatkitError, type Wait } from './internal.js';
import type { Failure, Hit, Stats, ViewEvent, Waiting } from './outputs.js';
import { Patch } from './patch.js';

/**
 * What a view tells its listeners, by type. Intents (`click`, `open`, `menu`, `drag`, `connect`,
 * `delete`) are told once each, in the order the user acted. Changes (`hovered`, `selection`,
 * `camera`, `waiting`) are named like the property they changed, and tell only their latest. A view
 * tells only what the application did not do itself: its setters change state silently.
 */
export type ViewEvents = {
  [E in ViewEvent as E['type']]: E extends { type: 'error' } ? LatkitError : E['detail'];
};

/** What a view is made with: the sources of the datasets its scene names. */
export interface ViewOptions {
  sources?: readonly Source[];
}

/** CSS pixels kept clear at the top, right, bottom, and left. */
export type Insets = [top: number, right: number, bottom: number, left: number];

/** A point on screen: CSS pixels from the top left. */
export type Point = [x: number, y: number];

/** A position in the space's coordinates: x, y, and elevation. */
export type Position = [x: number, y: number, elevation: number];

/** A scene drawn from the sources it is given: shown by a canvas, which passes it input, or drawn by shots. */
export class View {
  #listeners = new Map<keyof ViewEvents, Set<(event: never) => void>>();
  #scene: Scene;
  #sources: readonly Source[] = [];
  #released: () => void;

  private constructor(device: bindings.Gpu, scene: Scene, released: () => void) {
    hold(
      this,
      device.view(JSON.stringify(scene), (json: string) => this.#tell(json)),
    );
    this.#scene = scene;
    this.#released = released;
  }

  /** @internal A view of `scene` drawn with `device`, which calls `released` once destroyed. */
  static made(device: bindings.Gpu, scene: Scene, released: () => void): View {
    return new View(device, scene, released);
  }

  /** The scene drawn; setting an invalid one throws and keeps the scene drawn. */
  get scene(): Scene {
    return this.#scene;
  }

  set scene(scene: Scene) {
    view(this).setScene(JSON.stringify(scene));
    this.#scene = scene;
  }

  /**
   * What the view draws, each a dataset by name: a `Data`, its latest version from the frame after
   * each patch applies; a `Snapshot`, as it is; `Tiles`, the pieces the view asks for. A mark its
   * dataset no longer fits draws nothing, and the next frame tells why. Two sources of one name are
   * invalid.
   */
  get sources(): readonly Source[] {
    return this.#sources;
  }

  set sources(sources: readonly Source[]) {
    view(this).setSources(sources.map(sourceOf));
    this.#sources = [...sources];
  }

  /** The axis coordinate shown: sampled fields read their last frame at or before it. */
  get at(): number {
    return view(this).at;
  }

  set at(at: number) {
    view(this).at = at;
  }

  /** Where the view looks; setting it looks there at once. */
  get camera(): Camera {
    return JSON.parse(view(this).camera) as Camera;
  }

  set camera(camera: Camera) {
    view(this).setCamera(JSON.stringify(camera));
  }

  /** CSS pixels kept clear at the top, right, bottom, and left, as when panels cover the view. */
  get insets(): Insets {
    const [top, right, bottom, left] = view(this).insets;
    return [top!, right!, bottom!, left!];
  }

  set insets(insets: Insets) {
    view(this).insets = Float32Array.from(insets);
  }

  /** Degrees per second a map or plane turns around its center; 0 stops it. A diagram never turns. */
  get orbit(): number {
    return view(this).orbit;
  }

  set orbit(degreesPerSecond: number) {
    view(this).orbit = degreesPerSecond;
  }

  /** The rows selected, a set per table; setting it selects those and no others. */
  get selection(): readonly Rows[] {
    return JSON.parse(view(this).selection) as Rows[];
  }

  set selection(rows: readonly Rows[]) {
    view(this).setSelection(JSON.stringify(rows));
  }

  /** What the user points at: the row under the pointer, or the row the keys stepped to. */
  get hovered(): Hit | null {
    return JSON.parse(view(this).hovered) as Hit | null;
  }

  /** The work under way the last frame stood in for; empty once it is complete. */
  get waiting(): Waiting {
    return JSON.parse(view(this).waiting) as Waiting;
  }

  /**
   * Whether the last frame drew everything as the data, scene, and camera say, with nothing standing
   * in for work under way: what `waiting` lists. A shot waits for it.
   */
  get complete(): boolean {
    return view(this).complete;
  }

  /** Every mark that draws nothing because its data no longer fits it, and why. */
  get failures(): readonly LatkitError[] {
    return (JSON.parse(view(this).failures) as Failure[]).map(thrown);
  }

  /** What the view does each frame. */
  get stats(): Stats {
    return JSON.parse(view(this).stats) as Stats;
  }

  /** Whether the view wants a frame: it changed, or work it waited on landed. */
  get wantsFrame(): boolean {
    return view(this).wantsFrame;
  }

  /** Frames what `fit` names on the next frame, keeping pitch and bearing. */
  fit(fit: Fit = 'all'): void {
    view(this).fit(JSON.stringify(fit));
  }

  /** Eases to `camera`. */
  fly(camera: Camera): void {
    view(this).fly(JSON.stringify(camera));
  }

  /** Where `position` lands on screen; `null` behind the camera. */
  screen(position: Position): Point | null {
    const point = view(this).screen(Float64Array.from(position));
    return point ? [point[0]!, point[1]!] : null;
  }

  /** The position on the ground under screen point `point`; `null` where the view shows none there. */
  position(point: Point): Position | null {
    const position = view(this).position(Float32Array.from(point));
    return position ? [position[0]!, position[1]!, position[2]!] : null;
  }

  /** Where `row` lies on screen, or `null` when no mark draws it in view, once a frame draws the view. */
  screenOf(row: Row, wait: Wait = {}): Promise<Point | null> {
    return waited<Point | null>(view(this).screenOf(JSON.stringify(row)), wait, 'locating a row');
  }

  /**
   * Every row of a mark that picks within `radius` CSS pixels (0 unless given) of `point`, nearest
   * first, once a frame draws the view.
   */
  async pick(point: Point, options: { radius?: number } & Wait = {}): Promise<Hit[]> {
    const hits = view(this).pick(Float32Array.from(point), options.radius ?? 0);
    return JSON.parse(await waited<string>(hits, options, 'a pick')) as Hit[];
  }

  /**
   * The rows joined to `row`, a set per table: a vertex's neighbors across edges and nets, or an
   * edge's or a net's vertices.
   */
  neighbors(row: Row): Rows[] {
    return JSON.parse(view(this).neighbors(JSON.stringify(row))) as Rows[];
  }

  /**
   * Lays every vertex row without a position out again by the scene's layout: a diagram's blocks, or
   * points on a plane or the earth. Places a layout gave otherwise hold, so rows added later are
   * placed around the rest. Once the layout lands, answers a patch to each dataset writing each row
   * laid out into its mark's position fields; applied, the places are the data's own.
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
   * The version of dataset `name` the view draws: the latest version of a `Data` it took, a snapshot
   * given, or what it holds of `Tiles`, the pieces its camera asked for.
   */
  snapshot(name: string): Snapshot | undefined {
    const snapshot = view(this).snapshot(name);
    return snapshot ? snapshotOf(snapshot) : undefined;
  }

  /**
   * Calls `listener` with each event of `type` told while it listens; returns a function that stops
   * it. What lasts is state to read, as the property each change is named for.
   */
  on<T extends keyof ViewEvents>(type: T, listener: (event: ViewEvents[T]) => void): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Hands a batch of the view's events to the listeners of each one's type. */
  #tell(json: string): void {
    if (this.#listeners.size === 0) return;
    for (const told of JSON.parse(json) as ViewEvent[]) {
      const listeners = this.#listeners.get(told.type) as Set<(event: unknown) => void> | undefined;
      if (!listeners?.size) continue;
      const event = told.type === 'error' ? thrown(told.detail) : told.detail;
      for (const listener of listeners) listener(event);
    }
  }

  /** Frees the view, rejecting what it was asked and has not answered; a canvas showing it keeps its last frame. */
  destroy(): void {
    const freed = release<bindings.View>(this);
    if (!freed) return;
    for (const listeners of this.#listeners.values()) listeners.clear();
    this.#listeners.clear();
    freed.free();
    this.#released();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

function view(owner: View): bindings.View {
  return inner<bindings.View>(owner, 'View');
}

/** @internal The view as a canvas shows it or a shot draws it, each time anew. */
export function handleOf(owner: View): bindings.Handle {
  return view(owner).handle();
}
