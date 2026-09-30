import { GpuError } from './error.js';
import type { Viewport } from './render.js';

export interface Camera2D {
  readonly centerX: number;
  readonly centerY: number;
  /** CSS pixels per world unit. World y increases upwards. */
  readonly scale: number;
}
export type Bounds2D = readonly [minX: number, minY: number, maxX: number, maxY: number];
export type Insets = number | readonly [top: number, right: number, bottom: number, left: number];
type Size = Pick<Viewport, 'width' | 'height'>;

export function cameraPoint(
  camera: Camera2D,
  point: readonly [number, number],
  viewport: Size,
): readonly [number, number] {
  return [
    viewport.width / 2 + (point[0] - camera.centerX) * camera.scale,
    viewport.height / 2 - (point[1] - camera.centerY) * camera.scale,
  ];
}
export function worldPoint(
  camera: Camera2D,
  point: readonly [number, number],
  viewport: Size,
): readonly [number, number] {
  return [
    camera.centerX + (point[0] - viewport.width / 2) / camera.scale,
    camera.centerY - (point[1] - viewport.height / 2) / camera.scale,
  ];
}
export function fitCamera(bounds: Bounds2D, viewport: Size, padding: Insets = 32): Camera2D {
  const p = typeof padding === 'number' ? [padding, padding, padding, padding] : padding;
  if (
    !bounds.every(Number.isFinite) ||
    bounds[2] < bounds[0] ||
    bounds[3] < bounds[1] ||
    !p.every((v) => Number.isFinite(v) && v >= 0) ||
    !(
      [viewport.width, viewport.height].every(Number.isFinite) &&
      viewport.width > 0 &&
      viewport.height > 0
    )
  )
    throw new GpuError('invalid-input', 'Invalid camera bounds, viewport, or padding');
  const w = Math.max(1, viewport.width - p[1] - p[3]),
    h = Math.max(1, viewport.height - p[0] - p[2]);
  const dx = bounds[2] - bounds[0],
    dy = bounds[3] - bounds[1];
  const scale = Math.min(
    w / Math.max(dx, 1e-12),
    h / Math.max(dy, 1e-12),
    dx || dy ? Infinity : 64,
  );
  return {
    centerX: bounds[0] + dx / 2 - (p[3] - p[1]) / (2 * scale),
    centerY: bounds[1] + dy / 2 + (p[0] - p[2]) / (2 * scale),
    scale,
  };
}
/** Zoom while preserving the world point under the CSS-pixel anchor. */
export function zoomCamera(
  camera: Camera2D,
  factor: number,
  anchor: readonly [number, number],
  viewport: Size,
): Camera2D {
  if (!Number.isFinite(factor) || factor <= 0)
    throw new GpuError('invalid-input', 'Zoom factor must be positive');
  const before = worldPoint(camera, anchor, viewport),
    scale = camera.scale * factor;
  if (!Number.isFinite(scale) || scale <= 0)
    throw new GpuError('invalid-input', 'Invalid camera scale');
  return {
    centerX: before[0] - (anchor[0] - viewport.width / 2) / scale,
    centerY: before[1] + (anchor[1] - viewport.height / 2) / scale,
    scale,
  };
}
