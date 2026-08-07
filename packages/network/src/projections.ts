import { createGlobeProjection } from './camera/globe.js';
import { createPlaneProjection } from './camera/plane.js';
import type { Projection } from './camera/projection.js';
import type { Bounds } from './topology/index.js';

import planeSrc from './shaders/projections/plane-overlay.wgsl?raw';
import planeBgSrc from './shaders/projections/plane-background.wgsl?raw';
import planeRaySrc from './shaders/projections/plane-ray.wgsl?raw';
import globeSrc from './shaders/projections/globe-overlay.wgsl?raw';
import globeBgSrc from './shaders/projections/globe-background.wgsl?raw';
import globeRaySrc from './shaders/projections/globe-ray.wgsl?raw';
import daylightSrc from './shaders/projections/globe-daylight.wgsl?raw';

/** Canonical projection modes supported by the network renderer. */
export const PROJECTION_MODES = Object.freeze(['flat', 'tilt', 'globe'] as const);

/** Projection modes supported by the network renderer. */
export type ProjectionMode = (typeof PROJECTION_MODES)[number];

/** Shader/pipeline families. Flat and tilt share the planar bundle. */
export type PipelineMode = 'plane' | 'globe';

/**
 * Registry entry for one public camera view.
 */
export interface ProjectionDef {
  /** Stable mode identifier used by the public API and renderer state. */
  readonly mode: ProjectionMode;
  /** Creates a fresh camera projection implementation for this mode. */
  readonly create: () => Projection;
  /** Shared WebGPU pipeline bundle used by this view. */
  readonly pipeline: PipelineMode;
  /** Returns whether the loaded topology can be displayed in this mode. */
  readonly canUse: (bounds: Bounds | null, characteristicLength: number | null) => boolean;
}

/** Shader sources and fixed pipeline state for one pipeline family. */
export interface PipelineDef {
  /** Stable pipeline cache key and label prefix. */
  readonly mode: PipelineMode;
  /** Overlay prelude that implements the WGSL symbol contract below. */
  readonly overlayWgsl: string;
  /** WGSL body for `vertex_surface_world()`. */
  readonly vertexSurfaceWgsl: string;
  /** WGSL body for `segment_surface_world()`. */
  readonly segmentSurfaceWgsl: string;
  /** Background shader source. It must write `frag_depth`. */
  readonly bgWgsl: string;
  /** Extra WGSL sources required by the background shader. */
  readonly bgPreludeWgsl: string;
  /** WGSL body for `border_world()`, returning the final lifted world position. */
  readonly borderWorldWgsl: string;
  /** Depth compare used by focus halo pipelines. */
  readonly haloDepthCompare: 'always' | 'less-equal';
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
//   fn daylight(world: vec3f) -> f32                 return 1.0 when n/a
//
// Module composition per slot (what your code can see; webgpu/pipelines.ts
// owns the concatenation):
//   overlay: VISUAL_WGSL + overlayWgsl + uniforms + channel-* + topology + core
//   border:  VISUAL_WGSL + overlayWgsl + uniforms + borderWorldWgsl + borders
//   bg:      VISUAL_WGSL + uniforms + graticule + bgPreludeWgsl + bgWgsl
//            - NO overlay prelude: a bg shader cannot reference projection
//            overlay helpers unless its bgPreludeWgsl carries them.
//            graticule.wgsl owns the shared grid line rendering and flag
//            helper; flat/tilt use cartesian_grid, globe uses
//            geographic_graticule.
//
// Conventions:
//   u.plane_mix is 0 at flat rest and 1 for perspective/globe depth.
//   The bg shader MUST write frag_depth; the depth test against it is the
//   only overlay occlusion mechanism. No analytic occlusion in overlays.
//   displace_world owns the anti-z-fight base lift off the surface the bg
//   draws. Planar height moves continuously from clip depth to physical z.
//   border_world returns the FINAL lifted position too.
//   Picking is CPU-side: src/pick/project.ts mirrors this symbol contract
//   per mode over the same packed uniforms, and the pick parity tests pin
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

/** Returns whether topology bounds and scale are suitable for globe rendering. */
function canHostGlobe(bounds: Bounds | null, characteristicLength: number | null): boolean {
  if (!bounds || characteristicLength === null) return false;
  const b = bounds;
  if (b.xMin < -180 || b.xMax > 180 || b.yMin < -90 || b.yMax > 90) return false;
  if (b.xMax - b.xMin < GLOBE_MIN_DEG || b.yMax - b.yMin < GLOBE_MIN_DEG) return false;
  return characteristicLength <= GLOBE_MAX_CL;
}

/** Public camera-view registry. */
export const PROJECTIONS = Object.freeze({
  flat: {
    mode: 'flat',
    create: () => createPlaneProjection('flat'),
    pipeline: 'plane',
    canUse: () => true,
  },
  tilt: {
    mode: 'tilt',
    create: () => createPlaneProjection('tilt'),
    pipeline: 'plane',
    canUse: () => true,
  },
  globe: {
    mode: 'globe',
    create: createGlobeProjection,
    pipeline: 'globe',
    canUse: canHostGlobe,
  },
} satisfies Record<ProjectionMode, ProjectionDef>);

/** Minimal shader/pipeline registry: one bundle per coordinate family. */
export const PIPELINES = Object.freeze({
  plane: {
    mode: 'plane',
    overlayWgsl: planeSrc,
    vertexSurfaceWgsl: planarVertexSurfaceWgsl,
    segmentSurfaceWgsl: planarSegmentSurfaceWgsl,
    bgWgsl: planeBgSrc,
    bgPreludeWgsl: planeRaySrc,
    borderWorldWgsl:
      'fn border_world(lonlat: vec2f, ecef: vec3f) -> vec3f { return vec3f(lonlat, TILT_SURFACE_LIFT * u.vertex_size * u.plane_mix); }\n',
    haloDepthCompare: 'less-equal',
  },
  globe: {
    mode: 'globe',
    overlayWgsl: globeSrc + daylightSrc,
    vertexSurfaceWgsl: globeVertexSurfaceWgsl,
    segmentSurfaceWgsl: globeSegmentSurfaceWgsl,
    bgWgsl: globeBgSrc,
    bgPreludeWgsl: globeRaySrc + daylightSrc,
    // ecef is unit-length in the border asset; the normalize is the same
    // defensive posture the shared shader carried before the lift moved here.
    borderWorldWgsl:
      'fn border_world(lonlat: vec2f, ecef: vec3f) -> vec3f { return normalize(ecef) * (1.0 + GLOBE_SURFACE_OFFSET); }\n',
    haloDepthCompare: 'less-equal',
  },
} satisfies Record<PipelineMode, PipelineDef>);
