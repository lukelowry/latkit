import { FIT_PAD, type GraphBounds, type Viewport } from './camera/projection.js';

/**
 * Shared visual tuning constants used by the controller and generated WGSL.
 *
 * Pixel values are CSS pixels. World-scale values are fractions of graph
 * extent or topology characteristic length unless the property says otherwise.
 */
export const VISUAL = {
  /** Minimum edge half-width after projection. */
  minEdgeHalfWidthPx: 1,
  /** Maximum edge half-width after projection. */
  maxEdgeHalfWidthPx: 3,
  /** Maximum billboard radius for vertices. */
  maxVertexRadiusPx: 9,
  /** Focus ring thickness around vertex billboards. */
  vertexRingPx: 6,
  /** Angular vertex scale used by globe shaders. */
  globeVertexScale: Math.PI / 180,
  /** Angular edge scale used by globe shaders. */
  globeEdgeScale: Math.PI / 180,
  /** Radial height amplitude for globe height channels. */
  globeHeightRadialScale: 0.15,
  /** Small radial lift that keeps globe overlays above the sphere. */
  globeSurfaceOffset: 0.001,
  /** Vertex radius as a fraction of the topology's characteristic length. */
  vertexSizeScale: 0.08,
  /** Minimum multiplier for channel-driven vertex radius. */
  vertexSizeMinMul: 0.5,
  /** Maximum multiplier for channel-driven vertex radius. */
  vertexSizeMaxMul: 2.0,
  /** Base edge half-width as a fraction of the characteristic length. */
  baseEdgeWidthScale: 0.012,
  /** Target peak height at fit for flat/tilt. */
  heightTargetPx: 40,
  /** Clip-depth span reserved for height order in the flat view. */
  flatHeightDepthSpan: 0.25,
  /** Lower bound for flat/tilt height amplitude, in vertex radii. */
  heightMinVertexRadii: 3,
  /** Upper bound for height displacement relative to graph footprint. */
  heightMaxExtentFraction: 0.07,
  /**
   * Tilt anti-z-fight lift off the ground plane, in vertex radii.
   *
   * Overlay depth is vertex-interpolated while the background recomputes plane
   * depth per fragment, so zero-lift geometry would flicker.
   */
  tiltSurfaceLift: 0.05,
  /**
   * Per-fragment depth slack applied by tilt/globe backgrounds.
   *
   * Surface-anchored billboards carry one anchor depth across the quad; this
   * slack keeps the foreground surface from winning lower-half depth tests at
   * grazing pitch.
   */
  surfaceDepthSlackPx: 20,
  /**
   * Positive-w clip floor for segment and pole endpoints.
   *
   * Geometry straddling the camera plane clips against this floor before
   * perspective division, in the shaders and the CPU picker alike.
   */
  minClipW: 1e-4,
} as const;

/** WGSL source fragment mirroring the numeric constants in {@link VISUAL}. */
export const VISUAL_WGSL = `
const MIN_EDGE_HALF_WIDTH_PX: f32 = ${VISUAL.minEdgeHalfWidthPx};
const MAX_EDGE_HALF_WIDTH_PX: f32 = ${VISUAL.maxEdgeHalfWidthPx};
const MAX_VERTEX_RADIUS_PX: f32 = ${VISUAL.maxVertexRadiusPx};
const SIZE_MIN_MUL: f32 = ${VISUAL.vertexSizeMinMul};
const SIZE_MAX_MUL: f32 = ${VISUAL.vertexSizeMaxMul};
const VERTEX_RING_PX: f32 = ${VISUAL.vertexRingPx};
const GLOBE_VERTEX_SCALE: f32 = ${VISUAL.globeVertexScale};
const GLOBE_EDGE_SCALE: f32 = ${VISUAL.globeEdgeScale};
const GLOBE_SURFACE_OFFSET: f32 = ${VISUAL.globeSurfaceOffset};
const TILT_SURFACE_LIFT: f32 = ${VISUAL.tiltSurfaceLift};
const FLAT_HEIGHT_DEPTH_SPAN: f32 = ${VISUAL.flatHeightDepthSpan};
const SURFACE_DEPTH_SLACK_PX: f32 = ${VISUAL.surfaceDepthSlackPx};
const MIN_CLIP_W: f32 = ${VISUAL.minClipW};
const FRAGMENT_ALPHA_DISCARD: f32 = 0.001;
`;

/**
 * Calculates the flat/tilt height amplitude in graph-coordinate world units.
 *
 * Channel normalization maps values into roughly [-1, 1]. This viewport-derived
 * budget keeps range changes from changing the apparent maximum displacement.
 */
export function planeHeightWorldScale(
  bounds: GraphBounds,
  vp: Viewport,
  vertexSize: number,
): number {
  const min = vertexSize * VISUAL.heightMinVertexRadii;
  if (vp.w <= 0 || vp.h <= 0) return min;

  const bw = bounds.xMax - bounds.xMin || 1;
  const bh = bounds.yMax - bounds.yMin || 1;
  const pxPerWorld = Math.min((vp.w * FIT_PAD) / bw, (vp.h * FIT_PAD) / bh);
  const target = VISUAL.heightTargetPx / Math.max(pxPerWorld, 1e-9);
  const max = Math.max(bw, bh, 1e-9) * VISUAL.heightMaxExtentFraction;

  return Math.min(Math.max(target, Math.min(min, max)), max);
}
