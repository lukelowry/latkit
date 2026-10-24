/** Helios: flow through a synthetic network of five rings, its edges carrying comets. */
import { Patch, reference } from 'latkit';
import { TAU, THEME, framed, type Piece } from './look.ts';

export default function helios(): Piece {
  const rings = 5;
  const around = 96;
  const x: number[] = [];
  const y: number[] = [];
  const heat: number[] = [];
  const radius: number[] = [];
  const name: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let node = 0; node < around; node++) {
      const angle = (node * TAU) / around + ring * 0.075;
      const r = 92 + ring * 55 + 8 * Math.sin(angle * 6);
      x.push(r * Math.cos(angle));
      y.push(r * Math.sin(angle));
      heat.push(0.25 + 0.7 * Math.sin(angle * 0.5 + ring * 0.3) ** 2);
      const hub = node % 12 === 0;
      radius.push(hub ? 5 : 2.3);
      name.push(hub && ring === rings - 1 ? `S${String(node / 12 + 1).padStart(2, '0')}` : '');
      const here = ring * around + node;
      // Around each ring, inward across rings, and chords across the core.
      from.push(here);
      to.push(ring * around + ((node + 1) % around));
      if (ring > 0) {
        from.push(here);
        to.push((ring - 1) * around + ((node + 3) % around));
      }
      if (ring === 0 && node % 3 === 0) {
        from.push(here);
        to.push((node + 37) % around);
      }
    }
  }
  const data = new Patch('art')
    .replace('Bus', { count: x.length }, { x, y, heat, radius, name })
    .replace(
      'Branch',
      { count: from.length },
      { from: reference('Bus', from), to: reference('Bus', to) },
    );
  return {
    name: 'helios',
    alt: 'A synthetic network of 480 buses in five concentric rings, comets flowing along its 896 branches',
    data: [data],
    elapsed: 1.25,
    fit: framed([-335, -335, 335, 335]),
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: { ...THEME, flow: { color: '#d9fff0a0', spacing: 100 } },
      marks: [
        { edges: { of: ['art', 'Branch'], ends: ['from', 'to'], width: 0.85, flow: 18 } },
        {
          vertices: {
            of: ['art', 'Bus'],
            position: ['x', 'y'],
            radius: 'radius',
            color: { colormap: 'viridis', value: 'heat', domain: [0, 1] },
            label: { text: 'name', size: 13, color: '#c0e5dd' },
          },
        },
      ],
    },
  };
}
