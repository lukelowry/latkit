import type { Domain } from '@latkit/model';
import type { Plot } from './axes.js';
import { domain, expanded, fail } from './config.js';
import type { Monitor } from './monitor.js';
export const DEFAULT_CAMERA: Monitor.Camera = Object.freeze({
  x: [0, 1] as Domain,
  y: [0, 1] as Domain,
  fit: true,
});
/** A valid, frozen camera of exactly the monitor's keys. */
export function checkCamera(camera: Monitor.Camera): Monitor.Camera {
  if (typeof camera.fit !== 'boolean') fail('Invalid camera fit');
  return Object.freeze({
    x: domain(camera.x, 'camera x'),
    y: expanded(domain(camera.y, 'camera y')),
    fit: camera.fit,
  });
}
export function mixCamera(from: Monitor.Camera, to: Monitor.Camera, t: number): Monitor.Camera {
  const mix = (a: Domain, b: Domain): Domain => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  return { ...to, x: mix(from.x, to.x), y: mix(from.y, to.y) };
}
/** The camera moved by canvas pixels, for revealing a reading. */
export function move(camera: Monitor.Camera, dx: number, dy: number, plot: Plot): Monitor.Camera {
  const [x0, x1] = camera.x,
    [y0, y1] = camera.y;
  const sx = (dx * (x1 - x0)) / plot.width,
    sy = (dy * (y1 - y0)) / plot.height;
  return { ...camera, x: [x0 - sx, x1 - sx], y: [y0 + sy, y1 + sy] };
}
