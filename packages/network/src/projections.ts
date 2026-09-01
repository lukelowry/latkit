import { createGlobeProjection } from './camera/globe.js';
import { createPlaneProjection } from './camera/plane.js';
import type { Projection, Viewport } from './camera/projection.js';
import { globeProjector, planeProjector, type Projector } from './pick/project.js';
import type { Uniforms } from './webgpu/uniforms.js';
import { VISUAL, planeHeightWorldScale } from './visual.js';
import type { Bounds } from './topology/index.js';

import planeSrc from './shaders/projections/plane-overlay.wgsl?raw';
import planeBgSrc from './shaders/projections/plane-background.wgsl?raw';
import globeSrc from './shaders/projections/globe-overlay.wgsl?raw';
import globeBgSrc from './shaders/projections/globe-background.wgsl?raw';
import earthAxisSrc from './shaders/passes/earth-axis.wgsl?raw';

/** Canonical projection modes supported by the network renderer. */
export const PROJECTION_MODES = Object.freeze(['flat', 'tilt', 'globe'] as const);

/** Projection modes supported by the network renderer. */
export type ProjectionMode = (typeof PROJECTION_MODES)[number];

/**
 * Projection families: modes in one family share a camera state manifold and
 * a shader/pipeline bundle. Flat and tilt are views of the planar family.
 */
export type ProjectionFamily = 'plane' | 'globe';

/**
 * Registry entry for one public camera view.
 */
export interface ProjectionDef {
  /** Stable mode identifier used by the public API and renderer state. */
  readonly mode: ProjectionMode;
  /** Creates a fresh camera projection implementation for this mode. */
  readonly create: () => Projection;
  /** Camera-manifold and shader family this view belongs to. */
  readonly family: ProjectionFamily;
  /** Returns whether the loaded topology can be displayed in this mode. */
  readonly canUse: (bounds: Bounds | null, characteristicLength: number | null) => boolean;
  /** Projection-space visual amplitude for the normalized height channel. */
  readonly heightWorldScale: (bounds: Bounds, vp: Viewport, vertexSize: number) => number;
  /**
   * X axis is periodic longitude.
   *
   * Item bounds then take the minimal covering arc nearest the view center;
   * pose `centerX` and `screenToWorld()[0]` are degrees longitude when set.
   */
  readonly wrapX: boolean;
}

/** Shader sources and fixed pipeline state for one projection family. */
export interface PipelineDef {
  /** Stable pipeline cache key and label prefix. */
  readonly family: ProjectionFamily;
  /** CPU picking mirror over the same packed uniforms the shaders read. */
  readonly projector: (uniforms: Uniforms) => Projector;
  /** Overlay prelude that implements the WGSL symbol contract below. */
  readonly overlayWgsl: string;
  /** WGSL body for `sun_normal()`, feeding the shared daylight terminator. */
  readonly sunWgsl: string;
  /** WGSL body for `vertex_surface_world()`. */
  readonly vertexSurfaceWgsl: string;
  /** WGSL body for `segment_surface_world()`. */
  readonly segmentSurfaceWgsl: string;
  /** Background shader source. It must write `frag_depth`. */
  readonly bgWgsl: string;
  /** WGSL body for `border_world()`, returning the final lifted world position. */
  readonly borderWorldWgsl: string;
  /** Optional extra pass drawn behind overlays (the globe's earth axis). */
  readonly earthAxisWgsl?: string;
}

// WGSL symbol contract
//
// Every overlay prelude must define:
//   fn vertex_surface_world(id, pos) -> vec3f        vertex surface world position
//   fn segment_surface_world(seg, id, ep) -> vec3f   segment endpoint surface world position
//   fn to_world(pos: vec2f) -> vec3f                 topology coords -> world
//   fn displace_world(w: vec3f, h: f32) -> vec3f     base lift + height -> world
//   fn project_world(p: vec3f) -> vec4f              world -> clip
//   fn project_overlay(p: vec3f, h: f32) -> vec4f    overlay height -> clip depth
//   fn screen_radius(clip: vec4f) -> f32             vertex px radius (pre-LOD)
//   fn screen_half_width(clip: vec4f, w: f32) -> f32
//   fn screen_pole_half_width(clip: vec4f) -> f32
//   fn sun_normal(world: vec3f) -> vec3f             unit planet-center direction
//                                                    (sunWgsl; daylight input)
//
// Module composition per slot (what your code can see; webgpu/pipelines.ts
// owns the concatenation):
//   overlay: VISUAL_WGSL + overlayWgsl + daylight + sunWgsl + uniforms
//            + channel-* + topology + core
//   border:  VISUAL_WGSL + overlayWgsl + daylight + sunWgsl + uniforms
//            + borderWorldWgsl + borders
//   bg:      VISUAL_WGSL + uniforms + graticule + camera-ray + daylight
//            + sunWgsl + bgWgsl
//            - NO overlay prelude: a bg shader cannot reference projection
//            overlay helpers.
//            graticule.wgsl owns the shared grid line rendering and flag
//            helper; flat/tilt use cartesian_grid, globe uses
//            geographic_graticule. camera-ray.wgsl owns the per-fragment eye
//            ray from the packed camera basis; every bg gets it.
//            daylight.wgsl owns the shared solar terminator (and geo_to_xyz);
//            every slot gets it, and the family's sunWgsl supplies the
//            position -> planet-center direction map it shades with.
//
// Conventions:
//   u.depth_mix is 0 at flat rest and 1 for perspective/globe depth.
//   The bg shader MUST write frag_depth; the depth test against it is the
//   only overlay occlusion mechanism. No analytic occlusion in overlays.
//   displace_world owns the anti-z-fight base lift off the surface the bg
//   draws. Planar height moves continuously from clip depth to physical z.
//   border_world returns the FINAL lifted position too.
//   Picking is CPU-side: src/pick/project.ts mirrors this symbol contract
//   per family over the same packed uniforms, and the pick parity tests pin
//   the two implementations together.

/** A bounding box smaller than this (in degrees) stays off the globe. */
const GLOBE_MIN_DEG = 0.1;
/** Characteristic length above which the graph is too big for the globe view. */
const GLOBE_MAX_CL = 30;

const planarVertexSurfaceWgsl = `
fn vertex_surface_world(_vertex_id: u32, pos: vec2f) -> vec3f {
  return to_world(pos);
}
`;

/** WGSL adapter for planar segment endpoints already stored in graph coordinates. */
const planarSegmentSurfaceWgsl = `
fn segment_surface_world(seg: SegmentRecord, _segment_id: u32, endpoint: u32) -> vec3f {
  return to_world(select(seg.a, seg.b, endpoint == 1u));
}
`;

/** WGSL adapter for geographic vertices backed by precomputed sphere positions. */
const globeVertexSurfaceWgsl = `
fn vertex_surface_world(vertex_id: u32, _pos: vec2f) -> vec3f {
  return vertex_sphere(vertex_id);
}
`;

/** WGSL adapter for precomputed geographic segment endpoints on the unit sphere. */
const globeSegmentSurfaceWgsl = `
fn segment_surface_world(_seg: SegmentRecord, segment_id: u32, endpoint: u32) -> vec3f {
  return segment_sphere_endpoint(segment_id, endpoint);
}
`;

/**
 * Returns whether topology coordinates read as geographic lon/lat degrees.
 *
 * This is the availability gate for coordinate-interpreting features that any
 * projection can render (daylight shading); the globe additionally constrains
 * extent and scale via its `canUse`.
 */
export function isGeographic(bounds: Bounds | null): boolean {
  if (!bounds) return false;
  return bounds.xMin >= -180 && bounds.xMax <= 180 && bounds.yMin >= -90 && bounds.yMax <= 90;
}

/** Returns whether topology bounds and scale are suitable for globe rendering. */
function canHostGlobe(bounds: Bounds | null, characteristicLength: number | null): boolean {
  if (!bounds || characteristicLength === null) return false;
  if (!isGeographic(bounds)) return false;
  const b = bounds;
  if (b.xMax - b.xMin < GLOBE_MIN_DEG || b.yMax - b.yMin < GLOBE_MIN_DEG) return false;
  return characteristicLength <= GLOBE_MAX_CL;
}

/** Public camera-view registry. */
export const PROJECTIONS = Object.freeze({
  flat: {
    mode: 'flat',
    create: () => createPlaneProjection('flat'),
    family: 'plane',
    canUse: () => true,
    heightWorldScale: planeHeightWorldScale,
    wrapX: false,
  },
  tilt: {
    mode: 'tilt',
    create: () => createPlaneProjection('tilt'),
    family: 'plane',
    canUse: () => true,
    heightWorldScale: planeHeightWorldScale,
    wrapX: false,
  },
  globe: {
    mode: 'globe',
    create: createGlobeProjection,
    family: 'globe',
    canUse: canHostGlobe,
    heightWorldScale: () => VISUAL.globeHeightRadialScale,
    wrapX: true,
  },
} satisfies Record<ProjectionMode, ProjectionDef>);

/** Minimal shader/pipeline registry: one bundle per projection family. */
export const PIPELINES = Object.freeze({
  plane: {
    family: 'plane',
    projector: planeProjector,
    overlayWgsl: planeSrc,
    // Plane world coordinates are lon/lat degrees whenever daylight is armed
    // (FLAG_DAYLIGHT is gated on isGeographic), so the geographic conversion
    // is always meaningful here.
    sunWgsl: 'fn sun_normal(world: vec3f) -> vec3f { return geo_to_xyz(world.x, world.y); }\n',
    vertexSurfaceWgsl: planarVertexSurfaceWgsl,
    segmentSurfaceWgsl: planarSegmentSurfaceWgsl,
    bgWgsl: planeBgSrc,
    borderWorldWgsl:
      'fn border_world(lonlat: vec2f, ecef: vec3f) -> vec3f { return vec3f(lonlat, TILT_SURFACE_LIFT * u.vertex_size * u.depth_mix); }\n',
  },
  globe: {
    family: 'globe',
    projector: globeProjector,
    overlayWgsl: globeSrc,
    // Globe world positions sit on (or are lifted radially off) the unit
    // sphere; normalizing recovers the surface direction.
    sunWgsl: 'fn sun_normal(world: vec3f) -> vec3f { return normalize(world); }\n',
    vertexSurfaceWgsl: globeVertexSurfaceWgsl,
    segmentSurfaceWgsl: globeSegmentSurfaceWgsl,
    bgWgsl: globeBgSrc,
    // ecef is unit-length in the border asset; the normalize is the same
    // defensive posture the shared shader carried before the lift moved here.
    borderWorldWgsl:
      'fn border_world(lonlat: vec2f, ecef: vec3f) -> vec3f { return normalize(ecef) * (1.0 + GLOBE_SURFACE_OFFSET); }\n',
    earthAxisWgsl: earthAxisSrc,
  },
} satisfies Record<ProjectionFamily, PipelineDef>);
