/** Terrain: ridged mountains as a wire mesh over a grid of vertices, colored by height. */
import { Data, field, reference } from 'latkit';
import type { Picture } from './render.ts';

/** The height at `x`, `y`: sharpened ridges at six directions and scales, summed. */
function height(x: number, y: number): number {
  let h = 0;
  let amplitude = 1;
  for (let k = 0; k < 6; k++) {
    const angle = k * 1.13 + 0.4;
    const frequency = 0.0042 * 1.93 ** k;
    const along = x * Math.cos(angle) + y * Math.sin(angle);
    const across = -x * Math.sin(angle) + y * Math.cos(angle);
    const ridge =
      1 - Math.abs(Math.sin(frequency * along + 0.6 * Math.sin(frequency * 0.7 * across) + k));
    h += amplitude * ridge * ridge;
    amplitude *= 0.48;
  }
  // Cut a valley across the middle, and lower the land toward the edges.
  return (
    h *
    (0.35 + 0.65 * Math.min(1, Math.abs(y + 0.25 * x) / 260)) *
    (1 - Math.min(1, Math.hypot(x / 700, y / 440) ** 4))
  );
}

export default function (): Picture {
  const [columns, lines] = [300, 190];
  const [w, h] = [1400, 880];
  const n = columns * lines;
  // Vertex i's place on the grid, row by row.
  const xOf = (i: number) => ((i % columns) / (columns - 1) - 0.5) * w;
  const yOf = (i: number) => (Math.floor(i / columns) / (lines - 1) - 0.5) * h;
  const x = Float32Array.from({ length: n }, (_, i) => xOf(i));
  const y = Float32Array.from({ length: n }, (_, i) => yOf(i));
  const z = Float32Array.from({ length: n }, (_, i) => 150 * height(xOf(i), yOf(i)));
  // Horizontal, vertical, and diagonal grid edges, each stored once.
  const from: number[] = [],
    to: number[] = [];
  for (let row = 0; row < lines; row++) {
    for (let column = 0; column < columns; column++) {
      const at = row * columns + column;
      if (column + 1 < columns) {
        from.push(at);
        to.push(at + 1);
      }
      if (row + 1 < lines) {
        from.push(at);
        to.push(at + columns);
      }
      if (column + 1 < columns && row + 1 < lines) {
        from.push(at + 1);
        to.push(at + columns);
      }
    }
  }
  const land = new Data('land').replace('Vertex', { x, y, z }).replace('Edge', {
    from: reference('Vertex', Uint32Array.from(from)),
    to: reference('Vertex', Uint32Array.from(to)),
  });
  return {
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: { background: '#0b0f14' },
      marks: [
        // Hidden vertices place the wire mesh's endpoints and provide their colors.
        {
          vertices: land.table('Vertex'),
          position: ['$x', '$y'],
          elevation: '$z',
          radius: 0,
          pick: false,
          color: field('z')
            .colormap({
              kind: 'sequential',
              colors: ['#0e2a3f', '#1b5e6b', '#3f8f6e', '#a7a463', '#d9c9a3', '#f4efe6'],
            })
            .domain(0, 120),
        },
        { edges: land.table('Edge'), ends: ['from', 'to'], width: 0.65, pick: false },
      ],
    },
    camera: { center: [0, -20, 30], zoom: -0.9, pitch: 56, bearing: 22 },
  };
}
