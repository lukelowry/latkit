/** Clifford: a strange attractor of 260,000 translucent points, so density shows. */
import { Patch } from 'latkit';
import { THEME, framed, type Piece } from './look.ts';

export default function clifford(): Piece {
  // Just under 2^18 = 262,144 rows, past which a view pages a table instead of drawing it whole.
  const n = 260_000;
  const [a, b, c, d] = [-1.4, 1.6, 1.0, 0.7];
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const turn = new Float32Array(n);
  let [px, py] = [0.1, 0.1];
  for (let i = -100; i < n; i++) {
    const nx = Math.sin(a * py) + c * Math.cos(a * px);
    const ny = Math.sin(b * px) + d * Math.cos(b * py);
    if (i >= 0) {
      x[i] = nx * 300;
      y[i] = ny * 300;
      // The step's direction as a fraction of a turn, for a cyclic colormap.
      turn[i] = (Math.atan2(ny - py, nx - px) / (2 * Math.PI) + 1) % 1;
    }
    [px, py] = [nx, ny];
  }
  const data = new Patch('attractor').replace('Point', { count: n }, { x, y, turn });
  return {
    name: 'clifford',
    alt: 'A Clifford strange attractor of 260,000 translucent points, colored by the way each step turns',
    data: [data],
    fit: framed([-430, -395, 600, 465]),
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: THEME,
      marks: [
        {
          vertices: {
            of: ['attractor', 'Point'],
            position: ['x', 'y'],
            radius: 0.65,
            pick: false,
            color: {
              colormap: {
                kind: 'cyclic',
                colors: [
                  '#5a8dff8c',
                  '#9b6bff8c',
                  '#ff5fa28c',
                  '#ffb35c8c',
                  '#5ce0c28c',
                  '#5a8dff8c',
                ],
              },
              value: 'turn',
              domain: [0, 1],
            },
          },
        },
      ],
    },
  };
}
