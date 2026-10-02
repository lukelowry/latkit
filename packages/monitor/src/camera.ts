import type { ViewCamera } from '@latkit/gpu';
import type { Domain } from '@latkit/model';
import type { Plot } from './axes.js';
import { domain, expanded, fail } from './config.js';

/** What the monitor shows. */
export interface Camera extends ViewCamera {
  /** Coordinates shown, such as seconds. */
  readonly window: Domain;
  /** Values shown. */
  readonly values: Domain;
  /** Fit the values to the data in the window as it changes. Setting values turns it off. */
  readonly fit: boolean;
}
export const DEFAULT_CAMERA: Camera = Object.freeze({
  window: [0, 1] as Domain,
  values: [0, 1] as Domain,
  fit: true,
});
/** A valid, frozen camera of exactly the monitor's keys. */
export function checkCamera(camera: Camera): Camera {
  if (typeof camera.fit !== 'boolean') fail('Invalid camera fit');
  for (const key of Object.keys(camera))
    if (key !== 'window' && key !== 'values' && key !== 'fit') fail('Unknown camera key: ' + key);
  return Object.freeze({
    window: domain(camera.window, 'coordinate window'),
    values: expanded(domain(camera.values, 'value domain')),
    fit: camera.fit,
  });
}
export function sameDomain(a: Domain, b: Domain): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
export function mixCamera(from: Camera, to: Camera, t: number): Camera {
  const mix = (a: Domain, b: Domain): Domain => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  return { ...to, window: mix(from.window, to.window), values: mix(from.values, to.values) };
}
/** The camera moved by canvas pixels, for revealing a reading. */
export function move(camera: Camera, dx: number, dy: number, plot: Plot): Camera {
  const [x0, x1] = camera.window,
    [y0, y1] = camera.values;
  const sx = (dx * (x1 - x0)) / plot.width,
    sy = (dy * (y1 - y0)) / plot.height;
  return { ...camera, window: [x0 - sx, x1 - sx], values: [y0 + sy, y1 + sy] };
}
