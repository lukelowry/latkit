import { Camera } from './camera.js';
import { PROJECTIONS, type ProjectionMode } from '../projections.js';
import type { PlaneView, Projection, Viewport } from './projection.js';
import type { Bounds } from '../topology/types.js';
import type { ProjectionRegion } from '../webgpu/uniforms.js';

/** Keeps the active projection, mode, and camera synchronized during projection switches. */
export class ProjectionRig {
  /** Camera instance bound to the active projection. */
  camera: Camera;
  /** Projection implementation currently used for camera math and uniform packing. */
  projection: Projection;
  /** Public projection mode corresponding to the active projection implementation. */
  mode: ProjectionMode = 'flat';

  /** Creates a rig with the flat projection as the initial mode. */
  constructor(private readonly region: ProjectionRegion) {
    this.projection = PROJECTIONS.flat.create();
    this.camera = new Camera(this.projection, region);
  }

  /**
   * Switches to another projection, preserving the current view.
   *
   * The pose and anchor scale carry across projection families; with fit
   * intent still active the new projection's own fit is the truer translation
   * and wins. Entering tilt settles the target pitch to its resting oblique
   * through the chase, mirroring the in-family flat-to-tilt transition.
   *
   * @returns Whether the new camera was placed immediately. A false result
   * means the caller should request a fit once bounds and viewport are usable.
   */
  switchTo(mode: ProjectionMode, bounds: Bounds | null, vp: Viewport): boolean {
    const next = PROJECTIONS[mode];
    this.mode = mode;
    if (this.projection.family === 'plane' && (mode === 'flat' || mode === 'tilt')) {
      return this.camera.setView(mode, bounds, vp);
    }
    const carry = vp.w > 0 && vp.h > 0 && !this.camera.fitIntent;
    const pose = carry ? this.projection.pose(this.camera.current) : null;
    const px = carry ? this.projection.pxPerWorld(this.camera.current, vp) : 0;
    const fitIntent = this.camera.fitIntent;
    this.projection = next.create();
    this.camera = new Camera(this.projection, this.region);
    if (!bounds) return false;
    const placed = this.camera.place(pose, px, fitIntent, bounds, vp);
    if (placed && pose) {
      // Let the incoming view settle fields it prefers at rest: tilt eases
      // the carried pitch toward its oblique through the chase; flat's are
      // already clamped and the globe has no view to retarget.
      this.projection.setView?.(mode as PlaneView, this.camera.target);
    }
    return placed;
  }
}
