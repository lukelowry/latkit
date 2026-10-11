import type { Gpu } from '../gpu.js';
import type { FrameInfo, Viewport } from '../frame/render.js';
import type { Bounds2D } from './camera.js';
import { BaseItemView, type Grab, type ItemShape, type ItemView } from './item-view.js';
import { Projector, type ProjectedCamera } from './projection.js';
import { MAX_PITCH, type ProjectedStyle, type ResolvedViewStyle } from './style.js';
import type { Point } from './view.js';

type Mode = NonNullable<ItemView.Input['mode']>;
/** Degrees of bearing, and of pitch, a CSS pixel of a drag turns the camera. */
const TURN_BEARING = 0.4,
  TURN_PITCH = 0.25;
/** Degrees an orbit at rate 1 turns each millisecond, and the most time one step covers. */
const ORBIT = 0.012,
  ORBIT_STEP_MS = 100;
/** How far an arrow key turns the camera, in CSS pixels of a drag. */
const ARROW_PX = 24;

/**
 * The base of every view with a projected camera, over a plane or the earth. It fits from the
 * style's pitch and bearing, eases within a projection, pans, zooms, turns with the right button,
 * Shift, or Shift and an arrow, and orbits while motion is allowed; a view supplies the rest.
 */
export abstract class ProjectedView<
  Config extends ItemView.Config,
  Item,
  Hit extends Item,
  Events extends ItemView.Events<Item, Hit, ProjectedCamera>,
  Resolved,
  Prepared,
  Pipelines,
  Records extends keyof Config = never,
  Merged extends keyof Config = never,
> extends BaseItemView<
  Config,
  Item,
  Hit,
  ProjectedCamera,
  Events,
  Resolved,
  Prepared,
  Pipelines,
  Records,
  Merged
> {
  /** When the last presented frame turned the orbit, in the frames' clock. */
  #orbitTime?: number;
  readonly #orbiting = new WeakSet<FrameInfo>();
  constructor(gpu: Gpu, config: Config, shape: Omit<ItemShape<ProjectedCamera>, 'framed'>) {
    super(gpu, config, {
      ...shape,
      framed: ['projection', 'center', 'scale', 'pitch', 'bearing'],
    });
  }
  /** The view's resolved style, which holds the projected style. */
  protected abstract get style(): Required<ProjectedStyle> & ResolvedViewStyle;

  protected defaultCamera(): ProjectedCamera {
    return Projector.camera;
  }
  /** Orbiting needs motion and a tilt: turning it on tilts a flat camera. */
  protected resolveCamera(
    camera: ProjectedCamera,
    current: ProjectedCamera | undefined,
  ): ProjectedCamera {
    let next: ProjectedCamera = { ...camera, orbit: camera.orbit && !this.reducedMotion };
    if (next.orbit && !current?.orbit && next.projection === 'flat')
      next = { ...next, projection: 'tilt', pitch: this.style.fitPitch };
    return Projector.check(next);
  }
  protected interpolate(
    from: ProjectedCamera,
    to: ProjectedCamera,
    t: number,
  ): ProjectedCamera | undefined {
    return from.projection === to.projection ? Projector.mix(from, to, t) : undefined;
  }
  protected panned(camera: ProjectedCamera, dx: number, dy: number): ProjectedCamera {
    return { ...Projector.move(camera, dx, dy), orbit: false };
  }
  protected zoomed(
    camera: ProjectedCamera,
    factor: number,
    anchor: Point,
    viewport: Viewport,
  ): ProjectedCamera {
    return { ...Projector.zoom(camera, factor, anchor, viewport), orbit: false };
  }
  /** Turn the camera as a drag of canvas pixels does: a flat plane tilts to turn, the mercator plane only turns. */
  protected turn(dx: number, dy: number): void {
    const camera = this.camera;
    this.moveCamera(
      {
        projection: camera.projection === 'flat' ? 'tilt' : camera.projection,
        bearing: camera.bearing + dx * TURN_BEARING,
        pitch: Math.max(0, Math.min(MAX_PITCH, camera.pitch - dy * TURN_PITCH)),
        orbit: false,
      },
      {},
    );
  }
  /** The right button, or Shift, turns the camera; any other press pans as every view does. */
  protected grab(event: PointerEvent, point: Point, mode: Mode): Grab | undefined {
    if (mode === 'inspect' || (event.button !== 2 && !event.shiftKey)) return undefined;
    let last = point;
    return {
      move: (next) => {
        this.turn(next[0] - last[0], next[1] - last[1]);
        last = next;
      },
      end() {},
    };
  }
  /** Shift and an arrow turn the camera; plain arrows pan as in every view. */
  protected key(event: KeyboardEvent, mode: Mode): boolean {
    const step = arrowStep(event);
    if (!step || mode === 'inspect') return false;
    if (event.shiftKey) this.turn(step[0], step[1]);
    else this.pan(step[0], step[1]);
    return true;
  }
  /** The camera keys that frame bounds, from the style's pitch and bearing. */
  protected fitted(
    camera: ProjectedCamera,
    bounds: Bounds2D,
    viewport: Viewport,
  ): Partial<ProjectedCamera> {
    const { fitPaddingPx, fitPitch, fitBearing } = this.style;
    const { center, scale, pitch, bearing } = Projector.fit(
      camera,
      bounds,
      viewport,
      fitPaddingPx,
      {
        pitch: fitPitch,
        bearing: fitBearing,
      },
    );
    return { center, scale, pitch, bearing };
  }
  /**
   * The camera a frame draws, turned by its orbit since the last presented frame, and recorded as
   * the frame's own. Only presented frames turn it, and never under reduced motion: an export
   * draws the camera where it is.
   */
  protected orbited(frame: FrameInfo, camera: ProjectedCamera): ProjectedCamera {
    if (!camera.orbit || !frame.presented || this.reducedMotion) return camera;
    const last = this.#orbitTime,
      dt = last === undefined ? 0 : Math.max(0, Math.min(ORBIT_STEP_MS, frame.timeMs - last));
    const next = {
      ...camera,
      fit: false,
      bearing: camera.bearing + dt * ORBIT * this.style.orbitRate,
    };
    this.#orbiting.add(frame);
    this.drawCamera(frame, next);
    return next;
  }
  protected presented(frame: FrameInfo): void {
    super.presented(frame);
    this.#orbitTime = this.#orbiting.has(frame) ? frame.timeMs : undefined;
  }
  /** An orbit keeps frames coming, unless motion is reduced. */
  protected get animating(): boolean {
    return super.animating || (this.camera.orbit && !this.reducedMotion);
  }
}
/** The canvas pixels an arrow key moves by, or null for any other key. */
export function arrowStep(event: KeyboardEvent): Point | null {
  switch (event.key) {
    case 'ArrowLeft':
      return [ARROW_PX, 0];
    case 'ArrowRight':
      return [-ARROW_PX, 0];
    case 'ArrowUp':
      return [0, ARROW_PX];
    case 'ArrowDown':
      return [0, -ARROW_PX];
  }
  return null;
}
