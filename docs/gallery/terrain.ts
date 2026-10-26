/** Terrain: ridged mountains as lit triangles over a grid of vertices, colored by height. */
import { Patch, reference } from 'latkit';
import { THEME, floats, rows, type Piece } from './look.ts';

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

export default function terrain(): Piece {
  const [columns, lines] = [300, 190];
  const [w, h] = [1400, 880];
  const n = columns * lines;
  const px = (i: number) => ((i % columns) / (columns - 1) - 0.5) * w;
  const py = (i: number) => (Math.floor(i / columns) / (lines - 1) - 0.5) * h;
  const z = floats(n, (i) => 150 * height(px(i), py(i)));
  const cells = (columns - 1) * (lines - 1);
  // Two triangles per grid cell. Returns corner `k` (0 to 5) of the cell's triangles as a vertex
  // row.
  const corner = (cell: number, k: number) => {
    const c = cell % (columns - 1);
    const r = Math.floor(cell / (columns - 1));
    const at = r * columns + c;
    return [at, at + 1, at + columns, at + 1, at + columns + 1, at + columns][k]!;
  };
  const data = new Patch('land')
    .replace('Vertex', { count: n }, { x: floats(n, px), y: floats(n, py), z })
    .replace(
      'Face',
      { count: 2 * cells },
      {
        a: reference(
          'Vertex',
          rows(2 * cells, (f) => corner(f >> 1, (f & 1) * 3)),
        ),
        b: reference(
          'Vertex',
          rows(2 * cells, (f) => corner(f >> 1, (f & 1) * 3 + 1)),
        ),
        c: reference(
          'Vertex',
          rows(2 * cells, (f) => corner(f >> 1, (f & 1) * 3 + 2)),
        ),
      },
    );
  return {
    name: 'terrain',
    alt: 'Ridged mountains of 112,000 lit triangles, from deep teal valleys to pale summits, seen from above at an angle',
    data: [data],
    camera: { center: [0, -20, 30], zoom: -0.9, pitch: 56, bearing: 22 },
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: THEME,
      marks: [
        {
          vertices: {
            of: ['land', 'Vertex'],
            position: ['x', 'y'],
            elevation: 'z',
            radius: 0,
            pick: false,
            color: {
              colormap: {
                kind: 'sequential',
                colors: ['#0e2a3f', '#1b5e6b', '#3f8f6e', '#a7a463', '#d9c9a3', '#f4efe6'],
              },
              value: 'z',
              domain: [0, 120],
            },
          },
        },
        { faces: { of: ['land', 'Face'], corners: ['a', 'b', 'c'], pick: false } },
      ],
    },
  };
}
