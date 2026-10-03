import { failure } from '@latkit/model';
import { kit, type Viewport } from '@latkit/gpu';
import type { Style } from './options.js';
export type Projection = 'flat' | 'tilt' | 'globe';
const PROJECTIONS: readonly Projection[] = ['flat', 'tilt', 'globe'];
export interface Camera {
  readonly projection: Projection;
  /** Model coordinates; longitude and latitude in degrees for geographic data. */
  readonly center: readonly [x: number, y: number];
  /** Pixels per model unit. */
  readonly scale: number;
  /** Degrees from straight down, up to 80; zero when flat. */
  readonly pitch: number;
  /** Degrees clockwise. */
  readonly bearing: number;
  /** Keep the data in view as it changes; moving the view by hand turns it off. */
  readonly fit: boolean;
  /** Turn about the center. */
  readonly orbit: boolean;
}
export const DEG = Math.PI / 180;
export function turn(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}
export const DEFAULT_CAMERA: Camera = Object.freeze({
  projection: 'flat',
  center: Object.freeze([0, 0]) as unknown as Camera['center'],
  scale: 1,
  pitch: 0,
  bearing: 0,
  fit: true,
  orbit: false,
});
export function checkCamera(value: Camera): Camera {
  if (
    !PROJECTIONS.includes(value.projection) ||
    value.center?.length !== 2 ||
    ![...value.center, value.scale, value.pitch, value.bearing].every(Number.isFinite) ||
    value.scale <= 0 ||
    value.pitch < 0 ||
    value.pitch > 80 ||
    typeof value.fit !== 'boolean' ||
    typeof value.orbit !== 'boolean'
  )
    throw failure('invalid-input', 'Invalid camera');
  return Object.freeze({ ...value, pitch: value.projection === 'flat' ? 0 : value.pitch });
}
export function fit(
  bounds: kit.Bounds2D,
  viewport: Viewport,
  camera: Camera,
  options: Style,
): Camera {
  const pose = kit.fitCamera(bounds, viewport, options.fitPaddingPx);
  return {
    ...camera,
    center: [pose.center[0], pose.center[1]],
    scale: pose.scale[0],
    fit: true,
    bearing: options.fitBearing,
    pitch: camera.projection === 'flat' ? 0 : options.fitPitch,
  };
}
export function zoom(
  camera: Camera,
  factor: number,
  anchor: readonly [number, number],
  viewport: Viewport,
): Camera {
  const result = kit.zoomCamera(
    { center: camera.center, scale: [camera.scale, camera.scale], yDirection: 'up' },
    factor,
    anchor,
    viewport,
  );
  return {
    ...camera,
    center: [result.center[0], result.center[1]],
    scale: Math.max(1e-12, Math.min(1e12, result.scale[0])),
    fit: false,
  };
}
export function move(camera: Camera, dx: number, dy: number): Camera {
  const b = camera.bearing * DEG,
    cp = Math.max(0.15, Math.cos(camera.pitch * DEG));
  const x = -dx / camera.scale,
    y = dy / camera.scale / cp,
    limit = camera.projection === 'globe' ? 89.9 : Infinity;
  return {
    ...camera,
    center: [
      camera.center[0] + Math.cos(b) * x - Math.sin(b) * y,
      Math.max(-limit, Math.min(limit, camera.center[1] + Math.sin(b) * x + Math.cos(b) * y)),
    ],
    fit: false,
  };
}
export interface Projected {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly visible: boolean;
  readonly world: readonly [number, number, number];
  readonly clip: kit.ClipPoint;
}
export function project(
  camera: Camera,
  viewport: Viewport,
  x: number,
  y: number,
  height = 0,
): Projected {
  let dx = x - camera.center[0],
    dy = y - camera.center[1],
    z = height,
    facing = true;
  let scale = camera.scale;
  if (camera.projection === 'globe') {
    const lon = turn(camera.center[0], x) * DEG,
      lat = y * DEG,
      anchor = camera.center[1] * DEG;
    const ca = Math.cos(anchor),
      sa = Math.sin(anchor),
      cl = Math.cos(lat),
      sl = Math.sin(lat);
    dx = cl * Math.sin(lon);
    dy = sl * ca - cl * Math.cos(lon) * sa;
    const normal = sl * sa + cl * Math.cos(lon) * ca;
    dx *= 1 + height;
    dy *= 1 + height;
    z = normal * (1 + height) - 1;
    scale /= DEG;
    const distance = (viewport.height * 1.5) / scale;
    const p = camera.pitch * DEG,
      b = camera.bearing * DEG;
    const cy = -Math.sin(p) * distance,
      cz = 1 + Math.cos(p) * distance;
    const nx = -Math.sin(b) * cy,
      ny = Math.cos(b) * cy;
    facing = dx * nx + dy * ny + normal * cz > 1;
  }
  const b = camera.bearing * DEG,
    p = camera.pitch * DEG;
  const rx = dx * Math.cos(b) + dy * Math.sin(b);
  const ry = -dx * Math.sin(b) + dy * Math.cos(b);
  const distance = Math.max(1e-9, (viewport.height * 1.5) / scale);
  const w = camera.projection === 'flat' ? distance : distance + ry * Math.sin(p) - z * Math.cos(p);
  const sy = camera.projection === 'flat' ? ry : ry * Math.cos(p) + z * Math.sin(p);
  const depth =
    camera.projection === 'flat'
      ? 0.5 - height / (distance * 4)
      : (1 - (distance * 0.001) / w) / (1 - 0.001 / 1000);
  return {
    x: viewport.width / 2 + (rx * scale * distance) / w,
    y: viewport.height / 2 - (sy * scale * distance) / w,
    depth,
    visible:
      facing &&
      w > distance * 0.001 &&
      depth >= 0 &&
      depth <= 1 &&
      [x, y, height].every(Number.isFinite),
    world: [dx, dy, z],
    clip: [
      (rx * scale * distance * 2) / viewport.width,
      (sy * scale * distance * 2) / viewport.height,
      depth * w,
      w,
    ],
  };
}
export function mixCamera(a: Camera, b: Camera, t: number): Camera {
  return {
    ...b,
    center: [
      a.center[0] +
        (b.projection === 'globe' ? turn(a.center[0], b.center[0]) : b.center[0] - a.center[0]) * t,
      a.center[1] + (b.center[1] - a.center[1]) * t,
    ],
    scale: Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * t),
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    bearing: a.bearing + turn(a.bearing, b.bearing) * t,
  };
}

export function projectedStroke(
  a: Projected,
  b: Projected,
  camera: Camera,
  viewport: Viewport,
): readonly [Projected, Projected] | null {
  if (![...a.world, ...b.world].every(Number.isFinite)) return null;
  const range = kit.clipStroke(a.clip, b.clip);
  if (!range) return null;
  const sample = (t: number): Projected => {
    const clip = a.clip.map((v, i) => v + (b.clip[i] - v) * t) as unknown as kit.ClipPoint;
    const world = a.world.map((v, i) => v + (b.world[i] - v) * t) as unknown as Projected['world'];
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
/** Sphere occlusion at the actual hit, including elevated paths beyond the surface horizon. */
export function worldVisible(
  world: Projected['world'],
  camera: Camera,
  viewport: Viewport,
): boolean {
  if (camera.projection !== 'globe') return true;
  const p = camera.pitch * DEG,
    b = camera.bearing * DEG,
    distance = (viewport.height * 1.5) / (camera.scale / DEG);
  const eye = [
    Math.sin(b) * Math.sin(p) * distance,
    -Math.cos(b) * Math.sin(p) * distance,
    Math.cos(p) * distance,
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
