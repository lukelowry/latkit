import { failure } from '@latkit/model';
import type { Viewport } from '../frame/render.js';
import { clipStroke, type ClipPoint } from '../style/stroke.js';
import { fitCamera, zoomCamera, type Bounds2D, type Insets } from './camera.js';
import type { ItemView } from './item-view.js';

/** The camera every projected view shares: where it looks, how close, and from what angle. */
export interface ProjectedCamera extends ItemView.Camera {
  readonly projection: ProjectedCamera.Projection;
  /** Model coordinates; longitude and latitude in degrees for geographic data. */
  readonly center: readonly [x: number, y: number];
  /** Pixels per model unit. */
  readonly scale: number;
  /** Degrees from straight down, up to 80; zero unless the projection pitches. */
  readonly pitch: number;
  /** Degrees clockwise. */
  readonly bearing: number;
  /** Turn about the center. */
  readonly orbit: boolean;
}
export declare namespace ProjectedCamera {
  /** How a view lays its coordinates out: a plane, the mercator plane, a tilted plane, or a globe. */
  type Projection = 'flat' | 'mercator' | 'tilt' | 'globe';
}
/** Each projection's traits: whether it needs geographic coordinates, and whether it pitches. */
export const PROJECTIONS: Readonly<
  Record<ProjectedCamera.Projection, { readonly geographic: boolean; readonly pitched: boolean }>
> = Object.freeze({
  flat: Object.freeze({ geographic: false, pitched: false }),
  mercator: Object.freeze({ geographic: true, pitched: false }),
  tilt: Object.freeze({ geographic: false, pitched: true }),
  globe: Object.freeze({ geographic: true, pitched: true }),
});
/** The sun lighting a projected scene: where it shines from, and how dark night gets. */
export interface Light {
  /** Unit direction toward the sun, in the globe's frame. */
  readonly sun: readonly [number, number, number];
  /** How bright night stays, from 0 to 1. */
  readonly nightFloor: number;
  /** How wide the band from day to night is, in the dot product of normal and sun. */
  readonly terminatorWidth: number;
}
/** Where a point lands: canvas pixels, depth, whether it shows, and where it lies in the world. */
export interface Projected {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly visible: boolean;
  readonly world: readonly [number, number, number];
  readonly clip: ClipPoint;
}

const DEG = Math.PI / 180;
/** Mercator stops short of the poles, where it runs to infinity. */
const MERCATOR_LIMIT = 85.0511287798;
/** The globe's center along the view axis, in world units below the camera's ground point. */
const NEAR = 0.001;
/** Floats in the projection block every projected pipeline binds: six vec4. */
const BLOCK = 24;
/** Floats in the scene block every projected view's uniforms begin with: the projection, then the light. */
const SCENE = 32;

/** The shortest turn from one angle to another in degrees, from -180 to 180. */
function turn(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}
/** A latitude on the mercator plane, in degrees of longitude at the equator. */
function mercator(latitude: number): number {
  const l = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, latitude)) * DEG;
  return Math.log(Math.tan(Math.PI / 4 + l / 2)) / DEG;
}
/** The latitude a mercator coordinate stands for. */
function unmercator(y: number): number {
  return (2 * Math.atan(Math.exp(y * DEG)) - Math.PI / 2) / DEG;
}
/** The sun's direction at a time, in the globe's frame. */
function sunAt(timeMs: number): readonly [number, number, number] {
  const date = new Date(timeMs),
    day = (timeMs - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000;
  const declination = -23.44 * Math.cos((2 * Math.PI * (day + 10)) / 365.25) * DEG,
    longitude = (0.5 - (timeMs % 86400000) / 86400000) * Math.PI * 2;
  return [
    Math.cos(declination) * Math.cos(longitude),
    Math.sin(declination),
    -Math.cos(declination) * Math.sin(longitude),
  ];
}
/** A plane's y for a model y: the latitude's place on the mercator plane, or itself. */
function planeY(camera: ProjectedCamera, y: number): number {
  return camera.projection === 'mercator' ? mercator(y) : y;
}

/**
 * A camera on a viewport: projects model points to the canvas as every projected shader does, and
 * writes the projection block those shaders read. Its statics move and check cameras.
 */
export class Projector {
  /** Floats the projection block takes in a uniform buffer: six vec4. */
  static readonly floats = BLOCK;
  /**
   * Floats of the scene block a projected view's uniforms begin with: the projection, then the
   * light at `floats`. A view drawn beneath another binds its host's in place of its own.
   */
  static readonly scene = SCENE;
  /** The shortest turn from one angle to another in degrees, from -180 to 180. */
  static readonly turn = turn;
  /** A latitude's place on the mercator plane, in degrees of longitude at the equator. */
  static readonly mercator = mercator;
  /** The latitude a place on the mercator plane stands for. */
  static readonly latitude = unmercator;
  /** The sun's direction at a time, in the globe's frame. */
  static readonly sun = sunAt;
  /** Write a light, or none, into a uniform buffer at `at`: two vec4, as the shader's `Light`. */
  static readonly light = writeLight;
  /** Where a camera starts: flat at the origin, following the data. */
  static readonly camera: ProjectedCamera = Object.freeze({
    projection: 'flat',
    center: Object.freeze([0, 0]) as unknown as ProjectedCamera['center'],
    scale: 1,
    pitch: 0,
    bearing: 0,
    fit: true,
    orbit: false,
  });
  /** The camera, checked and normalized: an unpitched projection holds no pitch. */
  static check(camera: ProjectedCamera): ProjectedCamera {
    if (
      !Object.hasOwn(PROJECTIONS, camera.projection) ||
      camera.center?.length !== 2 ||
      ![...camera.center, camera.scale, camera.pitch, camera.bearing].every(Number.isFinite) ||
      camera.scale <= 0 ||
      camera.pitch < 0 ||
      camera.pitch > 80 ||
      typeof camera.fit !== 'boolean' ||
      typeof camera.orbit !== 'boolean'
    )
      throw failure('invalid-input', 'Invalid camera');
    const pitched = PROJECTIONS[camera.projection].pitched;
    return Object.freeze({ ...camera, pitch: pitched ? camera.pitch : 0 });
  }
  /** The camera framing model bounds with padding, at the given pitch and bearing where it pitches. */
  static fit(
    camera: ProjectedCamera,
    bounds: Bounds2D,
    viewport: Viewport,
    padding: Insets,
    view: { readonly pitch: number; readonly bearing: number },
  ): ProjectedCamera {
    const mercatorPlane = camera.projection === 'mercator';
    const plane: Bounds2D = mercatorPlane
      ? [bounds[0], mercator(bounds[1]), bounds[2], mercator(bounds[3])]
      : bounds;
    const pose = fitCamera(plane, viewport, padding);
    return {
      ...camera,
      center: [pose.center[0], mercatorPlane ? unmercator(pose.center[1]) : pose.center[1]],
      scale: pose.scale[0],
      fit: true,
      bearing: view.bearing,
      pitch: PROJECTIONS[camera.projection].pitched ? view.pitch : 0,
    };
  }
  /** The camera zoomed by a factor about a canvas point, which stays where it is. */
  static zoom(
    camera: ProjectedCamera,
    factor: number,
    anchor: readonly [number, number],
    viewport: Viewport,
  ): ProjectedCamera {
    const y = planeY(camera, camera.center[1]);
    const result = zoomCamera(
      { center: [camera.center[0], y], scale: [camera.scale, camera.scale], yDirection: 'up' },
      factor,
      anchor,
      viewport,
    );
    return {
      ...camera,
      center: [
        result.center[0],
        camera.projection === 'mercator' ? unmercator(result.center[1]) : result.center[1],
      ],
      scale: Math.max(1e-12, Math.min(1e12, result.scale[0])),
      fit: false,
    };
  }
  /** The camera moved by canvas pixels, along its bearing and pitch. */
  static move(camera: ProjectedCamera, dx: number, dy: number): ProjectedCamera {
    const b = camera.bearing * DEG,
      cp = Math.max(0.15, Math.cos(camera.pitch * DEG));
    const x = -dx / camera.scale,
      y = dy / camera.scale / cp,
      limit = camera.projection === 'globe' ? 89.9 : Infinity;
    const cx = camera.center[0] + Math.cos(b) * x - Math.sin(b) * y;
    let cy = camera.center[1];
    if (camera.projection === 'mercator')
      cy = unmercator(mercator(cy) + Math.sin(b) * x + Math.cos(b) * y);
    else cy = Math.max(-limit, Math.min(limit, cy + Math.sin(b) * x + Math.cos(b) * y));
    return { ...camera, center: [cx, cy], fit: false };
  }
  /** A camera part way from one to another of the same projection: the short way round a globe. */
  static mix(a: ProjectedCamera, b: ProjectedCamera, t: number): ProjectedCamera {
    return {
      ...b,
      center: [
        a.center[0] +
          (PROJECTIONS[b.projection].geographic
            ? turn(a.center[0], b.center[0])
            : b.center[0] - a.center[0]) *
            t,
        a.center[1] + (b.center[1] - a.center[1]) * t,
      ],
      scale: Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * t),
      pitch: a.pitch + (b.pitch - a.pitch) * t,
      bearing: a.bearing + turn(a.bearing, b.bearing) * t,
    };
  }

  /** Pixels per world unit: the camera's scale, per radian on a globe. */
  private readonly unit: number;
  /** How far the eye stands from the ground point, in world units. */
  private readonly distance: number;
  private readonly cosBearing: number;
  private readonly sinBearing: number;
  private readonly cosPitch: number;
  private readonly sinPitch: number;
  /** The center's place on its plane: its mercator y on the mercator plane. */
  private readonly centerY: number;
  constructor(
    readonly camera: ProjectedCamera,
    readonly viewport: Viewport,
  ) {
    this.unit = camera.scale / (camera.projection === 'globe' ? DEG : 1);
    this.distance = Math.max(1e-9, (viewport.height * 1.5) / this.unit);
    this.cosBearing = Math.cos(camera.bearing * DEG);
    this.sinBearing = Math.sin(camera.bearing * DEG);
    this.cosPitch = Math.cos(camera.pitch * DEG);
    this.sinPitch = Math.sin(camera.pitch * DEG);
    this.centerY = planeY(camera, camera.center[1]);
  }
  /**
   * Write the projection block at `at`: the viewport and kind, scale and distance, bearing and
   * pitch, the center's latitude and the drawn height, the center, and the center split into
   * high and low parts, which places points held relative to their own origins precisely.
   * `geographic` says whether the data's coordinates are longitude and latitude, which daylight
   * and the mercator plane read.
   */
  write(into: Float32Array, at: number, geographic: boolean, height = 0): void {
    const { camera, viewport } = this,
      kind = camera.projection === 'globe' ? 2 : camera.projection === 'tilt' ? 1 : 0,
      plane = camera.projection === 'mercator' ? 2 : geographic ? 1 : 0,
      [x, y] = camera.center,
      hx = Math.fround(x),
      hy = Math.fround(y);
    into.set(
      [
        viewport.width,
        viewport.height,
        viewport.pixelRatio,
        kind,
        this.unit,
        this.distance,
        this.centerY,
        0,
        this.cosBearing,
        this.sinBearing,
        this.cosPitch,
        this.sinPitch,
        Math.sin(camera.center[1] * DEG),
        Math.cos(camera.center[1] * DEG),
        height,
        plane,
        camera.center[0],
        camera.center[1],
        Math.sin(camera.center[0] * DEG),
        Math.cos(camera.center[0] * DEG),
        hx,
        hy,
        x - hx,
        y - hy,
      ],
      at,
    );
  }
  /** Where a model point and height land, as the shaders place them. */
  project(x: number, y: number, height = 0): Projected {
    const { camera, viewport, distance } = this;
    let dx = x - camera.center[0],
      dy = planeY(camera, y) - this.centerY,
      z = height,
      facing = true;
    if (camera.projection === 'globe') {
      const lon = turn(camera.center[0], x) * DEG,
        lat = y * DEG,
        anchor = camera.center[1] * DEG;
      const ca = Math.cos(anchor),
        sa = Math.sin(anchor),
        cl = Math.cos(lat),
        sl = Math.sin(lat);
      dx = cl * Math.sin(lon) * (1 + height);
      dy = (sl * ca - cl * Math.cos(lon) * sa) * (1 + height);
      const normal = sl * sa + cl * Math.cos(lon) * ca;
      z = normal * (1 + height) - 1;
      // The eye, in the frame the point lies in: a point faces it when it lies past the horizon plane.
      const cy = -this.sinPitch * distance,
        cz = 1 + this.cosPitch * distance;
      facing = dx * -this.sinBearing * cy + dy * this.cosBearing * cy + normal * cz > 1;
    }
    const flat = !PROJECTIONS[camera.projection].pitched;
    const rx = dx * this.cosBearing + dy * this.sinBearing,
      ry = -dx * this.sinBearing + dy * this.cosBearing;
    const w = flat ? distance : distance + ry * this.sinPitch - z * this.cosPitch,
      sy = flat ? ry : ry * this.cosPitch + z * this.sinPitch;
    const depth = flat
      ? 0.5 - height / (distance * 4)
      : (1 - (distance * NEAR) / w) / (1 - NEAR / 1000);
    return {
      x: viewport.width / 2 + (rx * this.unit * distance) / w,
      y: viewport.height / 2 - (sy * this.unit * distance) / w,
      depth,
      visible:
        facing &&
        w > distance * NEAR &&
        depth >= 0 &&
        depth <= 1 &&
        [x, y, height].every(Number.isFinite),
      world: [dx, dy, z],
      clip: [
        (rx * this.unit * distance * 2) / viewport.width,
        (sy * this.unit * distance * 2) / viewport.height,
        depth * w,
        w,
      ],
    };
  }
  /**
   * The model point under a canvas point on the ground: the plane, or the globe's surface; null
   * off the globe or above the horizon.
   */
  unproject(point: readonly [number, number]): readonly [number, number] | null {
    const { camera, viewport, distance } = this;
    const ndcX = (point[0] / viewport.width) * 2 - 1,
      ndcY = 1 - (point[1] / viewport.height) * 2;
    // The ray from the eye through the pixel, in the camera's turned frame.
    const right = [this.cosBearing, this.sinBearing, 0],
      front = [this.sinBearing * this.sinPitch, -this.cosBearing * this.sinPitch, this.cosPitch],
      up = [-this.sinBearing * this.cosPitch, this.cosBearing * this.cosPitch, this.sinPitch];
    const sx = (ndcX * viewport.width) / (2 * this.unit),
      sy = (ndcY * viewport.height) / (2 * this.unit);
    if (!PROJECTIONS[camera.projection].pitched) {
      const dx = sx * right[0] + sy * up[0],
        dy = sx * right[1] + sy * up[1];
      return [camera.center[0] + dx, this.modelY(this.centerY + dy)];
    }
    const eye = front.map((v) => v * distance),
      direction = [0, 1, 2].map((i) => right[i] * sx + up[i] * sy - front[i] * distance);
    if (camera.projection === 'tilt') {
      if (Math.abs(direction[2]) < 1e-9) return null;
      const t = -eye[2] / direction[2];
      if (t < 0) return null;
      const dx = eye[0] + direction[0] * t,
        dy = eye[1] + direction[1] * t;
      return [camera.center[0] + dx, camera.center[1] + dy];
    }
    // The globe: where the ray meets the unit sphere centered one unit below the ground point.
    const oc = [eye[0], eye[1], eye[2] + 1],
      a = direction.reduce((n, v) => n + v * v, 0),
      b = direction.reduce((n, v, i) => n + v * oc[i], 0),
      c = oc.reduce((n, v) => n + v * v, 0) - 1,
      disc = b * b - a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t < 0) return null;
    const hit = [0, 1, 2].map((i) => eye[i] + direction[i] * t);
    const n = [hit[0], hit[1], hit[2] + 1],
      ca = Math.cos(camera.center[1] * DEG),
      sa = Math.sin(camera.center[1] * DEG);
    // Back from the camera-centered frame to longitude and latitude.
    const north = n[1] * ca + n[2] * sa,
      east = n[0],
      toward = n[2] * ca - n[1] * sa;
    return [
      camera.center[0] + Math.atan2(east, toward) / DEG,
      Math.asin(Math.max(-1, Math.min(1, north))) / DEG,
    ];
  }
  /** A segment between two projected points clipped to the view, or null when none of it shows. */
  stroke(a: Projected, b: Projected): readonly [Projected, Projected] | null {
    if (![...a.world, ...b.world].every(Number.isFinite)) return null;
    const range = clipStroke(a.clip, b.clip);
    if (!range) return null;
    const { viewport } = this;
    const sample = (t: number): Projected => {
      const clip = a.clip.map((v, i) => v + (b.clip[i] - v) * t) as unknown as ClipPoint;
      const world = a.world.map(
        (v, i) => v + (b.world[i] - v) * t,
      ) as unknown as Projected['world'];
      return {
        x: ((clip[0] / clip[3] + 1) * viewport.width) / 2,
        y: ((1 - clip[1] / clip[3]) * viewport.height) / 2,
        depth: clip[2] / clip[3],
        clip,
        world,
        visible: true,
      };
    };
    return [range[0] === 0 ? a : sample(range[0]), range[1] === 1 ? b : sample(range[1])];
  }
  /** Whether a world point shows: the globe hides what lies behind it, raised points included. */
  visible(world: Projected['world']): boolean {
    if (this.camera.projection !== 'globe') return true;
    const eye = [
      this.sinBearing * this.sinPitch * this.distance,
      -this.cosBearing * this.sinPitch * this.distance,
      this.cosPitch * this.distance,
    ];
    const d = world.map((v, i) => v - eye[i]),
      oc = [eye[0], eye[1], eye[2] + 1];
    const aa = d.reduce((n, v) => n + v * v, 0),
      bb = d.reduce((n, v, i) => n + v * oc[i], 0),
      c = oc.reduce((n, v) => n + v * v, 0) - 1;
    const disc = bb * bb - aa * c;
    if (disc < 0 || aa === 0) return true;
    const t = (-bb - Math.sqrt(disc)) / aa;
    return t < 0 || t >= 0.9999;
  }
  /** A plane's y back as a model y: a latitude on the mercator plane. */
  private modelY(y: number): number {
    return this.camera.projection === 'mercator' ? unmercator(y) : y;
  }
}

/**
 * WGSL every projected pipeline includes: the `Projection` block `Projector.write` fills, the sun's
 * `Light`, and where points land, the ground and the globe's surface under a pixel, billboard depth,
 * daylight, and the mercator plane.
 */
export function projectionShader(): string {
  return `
struct Projection { view: vec4f, pose: vec4f, rotation: vec4f, geo: vec4f, center: vec4f, split: vec4f }
struct Light { sun: vec4f, night: vec4f }
/** What a projected view's uniforms begin with, and what a view drawn beneath another binds of its host's. */
struct Scene { projection: Projection, light: Light }
const PROJECTION_DEGREE: f32 = 0.017453292519943295;
/** Clip position of a world point relative to the camera's ground point. */
fn projection_clip(p: vec3f, q: Projection) -> vec4f {
  let rx = p.x * q.rotation.x + p.y * q.rotation.y;
  let ry = -p.x * q.rotation.y + p.y * q.rotation.x;
  let distance = q.pose.y;
  if (q.view.w < 0.5) {
    return vec4f(rx * q.pose.x * 2.0 / q.view.x, ry * q.pose.x * 2.0 / q.view.y, 0.5 - p.z / (distance * 4.0), 1.0);
  }
  let w = distance + ry * q.rotation.w - p.z * q.rotation.z;
  let y = ry * q.rotation.z + p.z * q.rotation.w;
  let depth = (w - distance * 0.001) / (1.0 - 0.001 / 1000.0);
  return vec4f(rx * q.pose.x * distance * 2.0 / q.view.x, y * q.pose.x * distance * 2.0 / q.view.y, depth, w);
}
/** A latitude's place on the mercator plane, in degrees of longitude at the equator. */
fn projection_mercator(latitude: f32) -> f32 {
  let l = clamp(latitude, -85.0511287798, 85.0511287798) * PROJECTION_DEGREE;
  return log(tan(0.7853981633974483 + l * 0.5)) / PROJECTION_DEGREE;
}
/** The latitude a place on the mercator plane stands for. */
fn projection_latitude(y: f32) -> f32 {
  return (2.0 * atan(exp(y * PROJECTION_DEGREE)) - 1.5707963267948966) / PROJECTION_DEGREE;
}
/**
 * Where a longitude and latitude, the longitude relative to the camera's, lie at a height: on the
 * unit globe, on the mercator plane, or on the plane of the data's own coordinates.
 */
fn projection_world(relative: vec2f, height: f32, q: Projection) -> vec3f {
  if (q.view.w > 1.5) {
    let lon = relative.x * PROJECTION_DEGREE;
    let lat = (relative.y + q.center.y) * PROJECTION_DEGREE;
    let cl = cos(lat);let sl = sin(lat);
    let dx = cl * sin(lon);
    let dy = sl * q.geo.y - cl * cos(lon) * q.geo.x;
    let normal = sl * q.geo.x + cl * cos(lon) * q.geo.y;
    return vec3f(dx, dy, normal) * (1.0 + height) - vec3f(0.0, 0.0, 1.0);
  }
  if (q.geo.w > 1.5) { return vec3f(relative.x, projection_mercator(relative.y + q.center.y) - q.pose.z, height); }
  return vec3f(relative, height);
}
/** Where a point held relative to an origin lies relative to the camera's center: the origin split, high then low parts, as the center is. */
fn projection_relative(origin: vec4f, local: vec2f, q: Projection) -> vec2f {
  return (origin.xy - q.split.xy) + (origin.zw - q.split.zw) + local;
}
/** CSS pixels a degree spans at the camera's center. */
fn projection_pixels(q: Projection) -> f32 {
  return select(q.pose.x, q.pose.x * PROJECTION_DEGREE, q.view.w > 1.5);
}
/** The globe's outward normal at an absolute longitude and latitude. */
fn projection_normal(lonlat: vec2f) -> vec3f {
  let lon = lonlat.x * PROJECTION_DEGREE;let lat = lonlat.y * PROJECTION_DEGREE;
  return vec3f(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
}
/** Where the ray through a pixel meets the globe, in the world; a w of 0 where it misses. */
fn projection_globe_hit(ndc: vec2f, q: Projection) -> vec4f { return projection_sphere_hit(ndc, q, 1.0); }
/** Where the ray through a pixel meets a sphere about the globe's center, \`radius\` globes across. */
fn projection_sphere_hit(ndc: vec2f, q: Projection, radius: f32) -> vec4f {
  let right = vec3f(q.rotation.x, q.rotation.y, 0.0);
  let up = vec3f(-q.rotation.y * q.rotation.z, q.rotation.x * q.rotation.z, q.rotation.w);
  let front = vec3f(q.rotation.y * q.rotation.w, -q.rotation.x * q.rotation.w, q.rotation.z);
  let eye = front * q.pose.y;
  let direction = right * ndc.x * q.view.x / (2.0 * q.pose.x) + up * ndc.y * q.view.y / (2.0 * q.pose.x) - front * q.pose.y;
  let oc = eye - vec3f(0.0, 0.0, -1.0);
  let a = dot(direction, direction);
  let b = dot(oc, direction);
  let disc = b * b - a * (dot(oc, oc) - radius * radius);
  if (disc < 0.0) { return vec4f(0.0); }
  let t = (-b - sqrt(disc)) / a;
  if (t < 0.0) { return vec4f(0.0); }
  return vec4f(eye + direction * t, 1.0);
}
/** Where the ray through a pixel meets the ground, and the ray itself. */
struct GroundPoint {
  /** From the camera's center: degrees on the globe and the mercator plane, the data's units on the planes. */
  relative: vec2f,
  /** The point in the world, on the globe and the tilted plane. */
  world: vec3f,
  /** The ray, from the eye toward the pixel. */
  eye: vec3f,
  direction: vec3f,
  hit: bool,
}
/** Where the ray through a pixel meets the ground: the plane, the mercator plane, the tilted plane, or the globe. */
fn projection_ground_point(ndc: vec2f, q: Projection) -> GroundPoint {
  let right = vec3f(q.rotation.x, q.rotation.y, 0.0);
  let up = vec3f(-q.rotation.y * q.rotation.z, q.rotation.x * q.rotation.z, q.rotation.w);
  let front = vec3f(q.rotation.y * q.rotation.w, -q.rotation.x * q.rotation.w, q.rotation.z);
  let sx = ndc.x * q.view.x / (2.0 * q.pose.x);
  let sy = ndc.y * q.view.y / (2.0 * q.pose.x);
  var g: GroundPoint;
  g.eye = front * q.pose.y;
  g.direction = right * sx + up * sy - front * q.pose.y;
  g.hit = true;
  if (q.view.w > 1.5) {
    let oc = g.eye + vec3f(0.0, 0.0, 1.0);
    let a = dot(g.direction, g.direction);
    let b = dot(oc, g.direction);
    let disc = b * b - a * (dot(oc, oc) - 1.0);
    if (disc < 0.0) { g.hit = false; return g; }
    g.world = g.eye + g.direction * ((-b - sqrt(disc)) / a);
    let n = g.world + vec3f(0.0, 0.0, 1.0);
    let sinLat = n.y * q.geo.y + n.z * q.geo.x;
    let toward = n.z * q.geo.y - n.y * q.geo.x;
    g.relative = vec2f(atan2(n.x, toward), asin(clamp(sinLat, -1.0, 1.0))) / PROJECTION_DEGREE - vec2f(0.0, q.center.y);
  } else if (q.view.w > 0.5) {
    if (abs(g.direction.z) < 0.000001 || -g.eye.z / g.direction.z < 0.0) { g.hit = false; return g; }
    g.world = g.eye + g.direction * (-g.eye.z / g.direction.z);
    g.relative = g.world.xy;
  } else {
    g.relative = (right * sx + vec3f(-q.rotation.y, q.rotation.x, 0.0) * sy).xy;
    // On the mercator plane, back from where mercator stretches a latitude.
    if (q.geo.w > 1.5) { g.relative.y = projection_latitude(g.relative.y + q.pose.z) - q.center.y; }
  }
  return g;
}
/**
 * A fragment's depth on a globe: its own, but never behind the surface under its pixel, less
 * \`lift\`, which bulges toward the camera across a marker or a label and would cut it.
 */
fn projection_billboard_depth(position: vec4f, q: Projection, lift: f32) -> f32 {
  if (q.view.w < 1.5) { return position.z; }
  let size = q.view.xy * q.view.z;
  let hit = projection_globe_hit(vec2f(position.x / size.x * 2.0 - 1.0, 1.0 - position.y / size.y * 2.0), q);
  if (hit.w == 0.0) { return position.z; }
  let clip = projection_clip(hit.xyz, q);
  return clamp(min(position.z, clip.z / clip.w - 0.000001 - lift), 0.0, 1.0);
}
/**
 * A fragment's depth where it lies on a globe at \`world\`, while that point faces the eye: as high
 * over the surface under its pixel as it stands, and never beneath it. A line between two points on
 * the surface, whose chord dips under it and whose round ends stand out over it, takes the surface's
 * own depth at every pixel, so it never sinks in, and its pieces never hide one another where they
 * meet. Behind the horizon, where the globe hides it, its own.
 */
fn projection_ground_depth(position: vec4f, world: vec3f, q: Projection, lift: f32) -> f32 {
  if (q.view.w < 1.5) { return position.z; }
  let sphere = world + vec3f(0.0, 0.0, 1.0);
  let front = vec3f(q.rotation.y * q.rotation.w, -q.rotation.x * q.rotation.w, q.rotation.z);
  if (dot(sphere, front * q.pose.y - world) <= 0.0) { return position.z; }
  let size = q.view.xy * q.view.z;
  let ndc = vec2f(position.x / size.x * 2.0 - 1.0, 1.0 - position.y / size.y * 2.0);
  let hit = projection_sphere_hit(ndc, q, max(length(sphere), 1.0));
  if (hit.w == 0.0) { return position.z; }
  let clip = projection_clip(hit.xyz, q);
  return clamp(clip.z / clip.w - 0.000001 - lift, 0.0, 1.0);
}
/** How lit a surface facing \`normal\` is: 1 in day, the night floor at night, eased across the terminator. */
fn projection_daylight(normal: vec3f, light: Light) -> f32 {
  if (light.sun.w < 0.5) { return 1.0; }
  return mix(light.night.x, 1.0, smoothstep(-light.night.y, light.night.y, dot(normal, light.sun.xyz)));
}
`;
}
/** Write a light, or none, into a uniform buffer at `at`: the sun and whether it shines, then the night. */
function writeLight(into: Float32Array, at: number, light: Light | null): void {
  if (!light) {
    into.fill(0, at, at + 8);
    return;
  }
  into.set([...light.sun, 1, light.nightFloor, Math.max(0.0001, light.terminatorWidth), 0, 0], at);
}
