/** Terrain: ridged mountains as lit triangles over a grid of vertices, colored by height. */
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
  const cells = (columns - 1) * (lines - 1);
  // Two triangles per grid cell. Returns corner `k` (0 to 5) of the cell's triangles as a vertex
  // row.
  const corner = (cell: number, k: number) => {
    const c = cell % (columns - 1);
    const r = Math.floor(cell / (columns - 1));
    const at = r * columns + c;
    return [at, at + 1, at + columns, at + 1, at + columns + 1, at + columns][k]!;
  };
  // Corner `k` (0 to 2) of every face. Faces 2c and 2c + 1 are cell c's two triangles.
  const corners = (k: number) => {
    const vertex = Uint32Array.from({ length: 2 * cells }, (_, f) =>
      corner(f >> 1, (f & 1) * 3 + k),
    );
    return reference('Vertex', vertex);
  };
  const land = new Data('land')
    .replace('Vertex', { x, y, z })
    .replace('Face', { a: corners(0), b: corners(1), c: corners(2) });
  return {
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: { background: '#0b0f14' },
      marks: [
        // The vertices draw nothing themselves: they place the faces' corners, and each face
        // blends its corners' colors.
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
        { faces: land.table('Face'), corners: ['a', 'b', 'c'], pick: false },
      ],
    },
    camera: { center: [0, -20, 30], zoom: -0.9, pitch: 56, bearing: 22 },
  };
}
