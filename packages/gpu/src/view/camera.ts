import { failure } from '@latkit/model';
import type { Viewport } from '../frame/render.js';
export interface Camera2D {
  readonly center: readonly [x: number, y: number];
  /** Positive CSS pixels per world unit on each axis. */
  readonly scale: readonly [x: number, y: number];
  readonly yDirection: 'up' | 'down';
}
export type Bounds2D = readonly [minX: number, minY: number, maxX: number, maxY: number];
export type Insets = number | readonly [top: number, right: number, bottom: number, left: number];
function direction(camera: Camera2D): number {
  return camera.yDirection === 'up' ? -1 : 1;
}
function check(camera: Camera2D, viewport: Pick<Viewport, 'width' | 'height'>): void {
  if (
    !camera.center.every(Number.isFinite) ||
    !camera.scale.every((v) => Number.isFinite(v) && v > 0) ||
    !['up', 'down'].includes(camera.yDirection) ||
    ![viewport.width, viewport.height].every((v) => Number.isFinite(v) && v > 0)
  )
    throw failure('invalid-input', 'Invalid camera or viewport');
}
export function cameraPoint(
  camera: Camera2D,
  point: readonly [number, number],
  viewport: Pick<Viewport, 'width' | 'height'>,
): readonly [number, number] {
  check(camera, viewport);
  return [
    viewport.width / 2 + (point[0] - camera.center[0]) * camera.scale[0],
    viewport.height / 2 + direction(camera) * (point[1] - camera.center[1]) * camera.scale[1],
  ];
}
export function worldPoint(
  camera: Camera2D,
  point: readonly [number, number],
  viewport: Pick<Viewport, 'width' | 'height'>,
): readonly [number, number] {
  check(camera, viewport);
  return [
    camera.center[0] + (point[0] - viewport.width / 2) / camera.scale[0],
    camera.center[1] + (direction(camera) * (point[1] - viewport.height / 2)) / camera.scale[1],
  ];
}
/** Top, right, bottom, and left of an inset; throws on a negative or nonfinite side. */
export function insetSides(padding: Insets): readonly [number, number, number, number] {
  const p = typeof padding === 'number' ? [padding, padding, padding, padding] : padding;
  if (!Array.isArray(p) || p.length !== 4 || !p.every((v) => Number.isFinite(v) && v >= 0))
    throw failure('invalid-input', 'Invalid padding');
  return p as unknown as readonly [number, number, number, number];
}
export function fitCamera(
  bounds: Bounds2D,
  viewport: Pick<Viewport, 'width' | 'height'>,
  padding: Insets = 32,
  options: {
    readonly aspect?: 'equal' | 'independent';
    readonly yDirection?: Camera2D['yDirection'];
  } = {},
): Camera2D {
  const p = insetSides(padding);
  if (
    !bounds.every(Number.isFinite) ||
    bounds[2] < bounds[0] ||
    bounds[3] < bounds[1] ||
    ![viewport.width, viewport.height].every((v) => Number.isFinite(v) && v > 0)
  )
    throw failure('invalid-input', 'Invalid camera bounds, viewport, or padding');
  const dx = bounds[2] - bounds[0],
    dy = bounds[3] - bounds[1],
    sx = Math.max(1, viewport.width - p[1] - p[3]) / Math.max(dx, 1e-12),
    sy = Math.max(1, viewport.height - p[0] - p[2]) / Math.max(dy, 1e-12);
  const scale: readonly [number, number] =
    options.aspect === 'independent'
      ? [dx ? sx : 64, dy ? sy : 64]
      : [Math.min(sx, sy, dx || dy ? Infinity : 64), Math.min(sx, sy, dx || dy ? Infinity : 64)];
  const yDirection = options.yDirection ?? 'up';
  const camera: Camera2D = {
    scale,
    yDirection,
    center: [
      bounds[0] + dx / 2 - (p[3] - p[1]) / (2 * scale[0]),
      bounds[1] + dy / 2 - ((yDirection === 'up' ? -1 : 1) * (p[0] - p[2])) / (2 * scale[1]),
    ],
  };
  check(camera, viewport);
  return camera;
}
/** Preserve the world point under a local CSS-pixel anchor. */
export function zoomCamera(
  camera: Camera2D,
  factor: number | readonly [number, number],
  anchor: readonly [number, number],
  viewport: Pick<Viewport, 'width' | 'height'>,
): Camera2D {
  const factors = typeof factor === 'number' ? [factor, factor] : factor;
  if (!factors.every((v) => Number.isFinite(v) && v > 0))
    throw failure('invalid-input', 'Zoom factors must be positive');
  const before = worldPoint(camera, anchor, viewport),
    scale: readonly [number, number] = [camera.scale[0] * factors[0], camera.scale[1] * factors[1]];
  const result: Camera2D = {
    ...camera,
    scale,
    center: [
      before[0] - (anchor[0] - viewport.width / 2) / scale[0],
      before[1] - (direction(camera) * (anchor[1] - viewport.height / 2)) / scale[1],
    ],
  };
  check(result, viewport);
  return result;
}
