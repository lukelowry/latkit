/** Currents: streamlines through a field of vortices, as on a wind map, colored by speed. */
import { Patch } from 'latkit';
import { THEME, framed, type Piece } from './look.ts';

/** Vortices as `[x, y, strength]`. The sign of the strength sets the direction of spin. */
const VORTICES = [
  [-380, 120, 1.0],
  [-120, -170, -0.8],
  [180, 160, 0.9],
  [430, -120, -1.1],
  [40, 20, 0.55],
  [-520, -230, 0.6],
  [560, 250, -0.5],
] as const;

/** The flow velocity at `x`, `y`: a steady eastward drift plus each vortex's swirl, which falls off
 * with distance from its center. */
function flow(x: number, y: number): [number, number] {
  let [u, v] = [0.35, 0.05];
  for (const [cx, cy, s] of VORTICES) {
    const [dx, dy] = [x - cx, y - cy];
    const falloff = Math.exp(-(dx * dx + dy * dy) / (2 * 170 * 170));
    u += (-s * dy * falloff) / 90;
    v += (s * dx * falloff) / 90;
  }
  return [u, v];
}

export default function currents(): Piece {
  const [w, h] = [1300, 720];
  const geometry: [number, number][][] = [];
  const speed: number[] = [];
  // Streamlines start on a grid, jittered by a fixed hash, so they cover the field evenly and the
  // same way on every run.
  const jitter = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1;
  // Streamlines stay inside an ellipse, so the field has a soft edge rather than a rectangular one.
  const inside = (x: number, y: number) => (x / (w / 2)) ** 2 + (y / (h / 2)) ** 2 < 1;
  for (let i = 0; i < 52 * 30; i++) {
    let x = (((i % 52) + 0.5 + 0.8 * jitter(i)) / 52 - 0.5) * w;
    let y = ((Math.floor(i / 52) + 0.5 + 0.8 * jitter(i + 7)) / 30 - 0.5) * h;
    if (!inside(x, y)) continue;
    const path: [number, number][] = [[x, y]];
    let travelled = 0;
    for (let s = 0; s < 70; s++) {
      // A midpoint step, which follows curves more closely than an Euler step.
      const [u0, v0] = flow(x, y);
      const [u, v] = flow(x + 2.5 * u0, y + 2.5 * v0);
      const length = Math.hypot(u, v);
      if (length < 1e-3) break;
      x += (u / length) * 5;
      y += (v / length) * 5;
      if (!inside(x, y)) break;
      path.push([x, y]);
      travelled += length;
    }
    if (path.length < 6) continue;
    geometry.push(path);
    speed.push(travelled / path.length);
  }
  const data = new Patch('wind').replace(
    'Streamline',
    { count: geometry.length },
    { geometry, speed },
  );
  return {
    name: 'currents',
    alt: 'Over two thousand streamlines swirling around seven vortices, slow ones deep blue and fast ones pale',
    data: [data],
    fit: framed([-w / 2, -h / 2, w / 2, h / 2]),
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: THEME,
      marks: [
        {
          lines: {
            of: ['wind', 'Streamline'],
            width: 0.75,
            color: {
              colormap: {
                kind: 'sequential',
                colors: ['#123056', '#1d5fd1', '#3f8cff', '#7cc4ff', '#cfe8ff'],
              },
              value: 'speed',
              domain: [0.2, 2.2],
            },
          },
        },
      ],
    },
  };
}
