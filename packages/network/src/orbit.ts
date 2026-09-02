/**
 * Continuous rotation behind `Network.orbit`: a flat view promotes to tilt, a planar view drags
 * horizontally, and a globe drifts longitude at a visually matched rate. The driver owns motion
 * and frame timing; the controller stops it on the first pointer or wheel gesture.
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

/** Frame scheduling seams, `requestAnimationFrame` unless a test injects its own. */
export interface OrbitFrames {
  readonly scheduleFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

/** One orbit driver: idempotent start and stop, plus the current state. */
export interface Orbit {
  readonly active: boolean;
  /** Begin rotating, promoting a flat view to tilt; false when no 3D projection is available. */
  start(): boolean;
  stop(): void;
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

/** Create the rotation driver for one target; `onChange` observes every start and stop. */
export function createOrbit(
  target: OrbitTarget,
  onChange: (active: boolean) => void,
  frames: OrbitFrames = {},
): Orbit {
  const scheduleFrame =
    frames.scheduleFrame ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame = frames.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  let frame: number | null = null;
  let previous: number | null = null;

  const advance = (elapsedMs: number): void => {
    if (target.projection !== 'globe') {
      target.rotateBy(elapsedMs * TILT_PX_PER_MS, 0);
      return;
    }
    const pose = target.getPose();
    if (pose) target.setPose({ centerX: pose.centerX + elapsedMs * GLOBE_DEG_PER_MS }, true);
  };

  const stop = (): void => {
    if (frame === null) return;
    cancelFrame(frame);
    frame = null;
    previous = null;
    onChange(false);
  };

  const tick: FrameRequestCallback = (time) => {
    if (frame === null) return;
    if (previous !== null) advance(Math.min(time - previous, MAX_FRAME_MS));
    previous = time;
    frame = scheduleFrame(tick);
  };

  return {
    get active() {
      return frame !== null;
    },
    start() {
      if (frame !== null) return true;
      if (!canOrbit(target)) return false;
      if (target.projection === 'flat') target.setProjection('tilt');
      frame = scheduleFrame(tick);
      onChange(true);
      return true;
    },
    stop,
  };
}
