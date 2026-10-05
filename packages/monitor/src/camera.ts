import type { ViewCamera } from '@latkit/gpu';
import type { Domain } from '@latkit/model';
import type { Plot } from './axes.js';
import { domain, expanded, fail } from './config.js';

/** What the monitor shows: the coordinates along x, such as seconds, and the values along y. */
export interface Camera extends ViewCamera {
  readonly x: Domain;
  readonly y: Domain;
  /** Fit y to the data in x as it changes. Setting y turns it off. */
  readonly fit: boolean;
}
export const DEFAULT_CAMERA: Camera = Object.freeze({
  x: [0, 1] as Domain,
  y: [0, 1] as Domain,
  fit: true,
});
/** A valid, frozen camera of exactly the monitor's keys. */
export function checkCamera(camera: Camera): Camera {
  if (typeof camera.fit !== 'boolean') fail('Invalid camera fit');
  return Object.freeze({
    x: domain(camera.x, 'camera x'),
    y: expanded(domain(camera.y, 'camera y')),
    fit: camera.fit,
  });
}
export function mixCamera(from: Camera, to: Camera, t: number): Camera {
  const mix = (a: Domain, b: Domain): Domain => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  return { ...to, x: mix(from.x, to.x), y: mix(from.y, to.y) };
}
/** The camera moved by canvas pixels, for revealing a reading. */
export function move(camera: Camera, dx: number, dy: number, plot: Plot): Camera {
  const [x0, x1] = camera.x,
    [y0, y1] = camera.y;
  const sx = (dx * (x1 - x0)) / plot.width,
    sy = (dy * (y1 - y0)) / plot.height;
  return { ...camera, x: [x0 - sx, x1 - sx], y: [y0 + sy, y1 + sy] };
}
