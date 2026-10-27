/** Helios: a synthetic network of five rings, with comets flowing along its edges. */
import { Data, field, reference } from 'latkit';
import { framed } from './look.ts';
import type { Picture } from './render.ts';

export default function (): Picture {
  const rings = 5;
  const around = 96;
  const x: number[] = [];
  const y: number[] = [];
  const heat: number[] = [];
  const radius: number[] = [];
  const name: (string | null)[] = [];
  const from: number[] = [];
  const to: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let node = 0; node < around; node++) {
      const angle = (2 * Math.PI * node) / around + ring * 0.075;
      const r = 92 + ring * 55 + 8 * Math.sin(angle * 6);
      x.push(r * Math.cos(angle));
      y.push(r * Math.sin(angle));
      heat.push(0.25 + 0.7 * Math.sin(angle * 0.5 + ring * 0.3) ** 2);
      const hub = node % 12 === 0;
      radius.push(hub ? 5 : 2.3);
      // Only the outer ring's hubs are named. Other buses have no name, so they have no label.
      name.push(hub && ring === rings - 1 ? `S${String(node / 12 + 1).padStart(2, '0')}` : null);
      const here = ring * around + node;
      // Branches run around each ring, inward to the ring inside it, and as chords across the core.
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
  const art = new Data('art')
    .replace('Bus', { x, y, heat, radius, name })
    .replace('Branch', { from: reference('Bus', from), to: reference('Bus', to) });
  return {
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      // The dark theme, with a darker background and labels without halos.
      theme: {
        background: '#0b0f14',
        text: { color: '#c3ccd6', font: 'sans-serif', size: 12, halo: 0 },
        flow: { color: '#d9fff0a0', spacing: 100 },
      },
      marks: [
        { edges: art.table('Branch'), ends: ['from', 'to'], width: 0.85, flow: 18 },
        {
          vertices: art.table('Bus'),
          position: ['$x', '$y'],
          radius: '$radius',
          color: field('heat').colormap('viridis').domain(0, 1),
          label: { text: '$name', size: 13, color: '#c0e5dd' },
        },
      ],
    },
    fit: framed([-335, -335, 335, 335]),
    elapsed: 1.25,
  };
}
