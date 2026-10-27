/** Golden bloom: seeds placed a golden angle apart, colored by an eight-armed spiral wave. */
import { Data, field } from 'latkit';
import { framed } from './look.ts';
import type { Picture } from './render.ts';

export default function (): Picture {
  const seeds = 32_000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = (i: number) => 2.2 * Math.sqrt(i);
  const angle = (i: number) => i * golden;
  // The seed's polar angle around the center, in [0, 2π).
  const polar = (i: number) => angle(i) % (2 * Math.PI);
  const each = { length: seeds };
  const bloom = new Data('bloom').replace('Seed', {
    x: Float32Array.from(each, (_, i) => r(i) * Math.cos(angle(i))),
    y: Float32Array.from(each, (_, i) => r(i) * Math.sin(angle(i))),
    // Eight spiral arms winding outward, with dark gaps between them.
    wave: Float32Array.from(
      each,
      (_, i) => (0.5 + 0.5 * Math.sin(r(i) * 0.05 - 8 * polar(i))) ** 1.6,
    ),
    size: Float32Array.from(each, (_, i) => 0.5 + 0.85 * Math.sqrt(i / seeds)),
  });
  const edge = r(seeds) + 4;
  return {
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: { background: '#0b0f14' },
      marks: [
        {
          vertices: bloom.table('Seed'),
          position: ['$x', '$y'],
          radius: '$size',
          pick: false,
          color: field('wave')
            .colormap({
              kind: 'sequential',
              colors: ['#101830', '#1f3a8a', '#5b48d6', '#c45496', '#f58b72', '#ffd890'],
            })
            .domain(0, 1),
        },
      ],
    },
    fit: framed([-edge, -edge, edge, edge]),
  };
}
