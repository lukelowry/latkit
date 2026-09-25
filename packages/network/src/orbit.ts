/**
 * Continuous rotation behind `Network.orbit`: a flat view promotes to tilt, a planar view drags
 * horizontally, and a globe drifts longitude at a visually matched rate. The driver owns motion;
 * the view's frame loop advances it, and the controller stops it on the first pointer or wheel
 * gesture.
 */

import type { Pose } from './camera/projection.js';
import type { Projection } from './projections.js';

/** The slice of camera control an orbit drives. */
export interface OrbitTarget {
  readonly projection: Projection;
  readonly projections: Readonly<Record<Projection, boolean>>;
  setProjection(mode: Projection): boolean;
  rotateBy(dx: number, dy: number): void;
  getPose(): Pose | null;
  setPose(pose: Partial<Pose>, animate?: boolean): boolean;
}

/** One orbit driver: idempotent start and stop, the current state, and its per-frame advance. */
export interface Orbit {
  readonly active: boolean;
  /** Begin rotating, promoting a flat view to tilt; false when no 3D projection is available. */
  start(): boolean;
  stop(): void;
  /** Rotate by the time since the previous frame; a start or stop re-anchors the time. */
  advance(now: number): void;
}

/** Frames longer than this (a background tab waking up) advance as if they were this long. */
const MAX_FRAME_MS = 50;
/** Screen-space drag rate for planar views, visually matched to the globe drift below. */
const TILT_PX_PER_MS = 0.02;
const GLOBE_DEG_PER_MS = 0.008;

/** Whether continuous rotation can run: any 3D view, or a flat view whose topology offers tilt. */
export function canOrbit(view: Pick<OrbitTarget, 'projection' | 'projections'>): boolean {
  return view.projection !== 'flat' || view.projections.tilt;
}

/**
 * Create the rotation driver for one target; `onChange` observes every start and stop, and `rate`
 * multiplies the rotation rate (the `orbitRate` option).
 */
export function createOrbit(
  target: OrbitTarget,
  onChange: (active: boolean) => void,
  rate: () => number = () => 1,
): Orbit {
  let active = false;
  let previous: number | null = null;

  const move = (elapsedMs: number): void => {
    const scaled = elapsedMs * rate();
    if (target.projection !== 'globe') {
      target.rotateBy(scaled * TILT_PX_PER_MS, 0);
      return;
    }
    const pose = target.getPose();
    if (pose) target.setPose({ centerX: pose.centerX + scaled * GLOBE_DEG_PER_MS }, true);
  };

  return {
    get active() {
      return active;
    },
    start() {
      if (active) return true;
      if (!canOrbit(target)) return false;
      if (target.projection === 'flat') target.setProjection('tilt');
      active = true;
      previous = null;
      onChange(true);
      return true;
    },
    stop() {
      if (!active) return;
      active = false;
      previous = null;
      onChange(false);
    },
    advance(now) {
      if (!active) return;
      if (previous !== null) move(Math.min(now - previous, MAX_FRAME_MS));
      previous = now;
    },
  };
}
