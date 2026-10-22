/** Golden bloom: seeds a golden angle apart, colored by a wave turning through them. */
import { Patch } from 'latkit/core';
import { THEME, floats, framed, type Piece } from './look.ts';

export default function bloom(): Piece {
  const seeds = 32_000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = (i: number) => 2.2 * Math.sqrt(i);
  const angle = (i: number) => i * golden;
  // Where a seed lies around the center, unwound from its golden angle.
  const polar = (i: number) => angle(i) % (2 * Math.PI);
  const data = Patch.to('bloom').replace(
    'Seed',
    { count: seeds },
    {
      x: floats(seeds, (i) => r(i) * Math.cos(angle(i))),
      y: floats(seeds, (i) => r(i) * Math.sin(angle(i))),
      // Eight arms winding outward through the seeds, dark between them.
      wave: floats(seeds, (i) => (0.5 + 0.5 * Math.sin(r(i) * 0.05 - 8 * polar(i))) ** 1.6),
      size: floats(seeds, (i) => 0.5 + 0.85 * Math.sqrt(i / seeds)),
    },
  );
  const edge = r(seeds) + 4;
  return {
    name: 'bloom',
    alt: 'Thirty-two thousand seeds a golden angle apart, in arms of sapphire, rose, and amber',
    data: [data],
    fit: framed([-edge, -edge, edge, edge]),
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: THEME,
      title: 'Golden bloom',
      subtitle: '32,000 seeds a golden angle apart, colored by a wave winding through them',
      marks: [
        {
          vertices: {
            of: ['bloom', 'Seed'],
            position: ['x', 'y'],
            radius: 'size',
            pick: false,
            color: {
              colormap: {
                kind: 'sequential',
                colors: ['#101830', '#1f3a8a', '#5b48d6', '#c45496', '#f58b72', '#ffd890'],
              },
              value: 'wave',
              domain: [0, 1],
            },
          },
        },
      ],
    },
  };
}
