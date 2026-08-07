import { Camera } from './camera.js';
import { PROJECTIONS, type ProjectionMode } from '../projections.js';
import type { GraphBounds, Projection, Viewport } from './projection.js';
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
   * Switches to another projection while preserving the current pose when the
   * outgoing and incoming projections can translate it.
   *
   * @returns Whether the new camera was placed immediately. A false result
   * means the caller should request a fit once bounds and viewport are usable.
   */
  switchTo(mode: ProjectionMode, bounds: GraphBounds | null, vp: Viewport): boolean {
    const next = PROJECTIONS[mode];
    this.mode = mode;
    if (this.projection.family === 'plane' && (mode === 'flat' || mode === 'tilt')) {
      return this.camera.setView(mode, bounds, vp);
    }
    const pose = this.projection.exportPose?.(this.camera.current, vp) ?? null;
    const fitIntent = this.camera.fitIntent;
    this.projection = next.create();
    this.camera = new Camera(this.projection, this.region);
    if (!bounds) return false;
    return this.camera.initFrom(pose, fitIntent, bounds, vp);
  }
}
