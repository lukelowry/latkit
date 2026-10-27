/** Tides: nested closed contours, each rippled by harmonics whose phases shift with its level. */
import { Patch } from 'latkit';
import { TAU, THEME, framed, type Piece } from './look.ts';

export default function tides(): Piece {
  const contours = 110;
  const steps = 600;
  const geometry: [number, number][][] = [];
  const level: number[] = [];
  for (let c = 0; c < contours; c++) {
    const l = c / (contours - 1);
    const r = 50 + 270 * l;
    const path: [number, number][] = [];
    for (let s = 0; s <= steps; s++) {
      const a = (s / steps) * TAU;
      const ripple =
        1 +
        0.13 * Math.sin(3 * a + 5 * l) +
        0.07 * Math.cos(7 * a - 4 * l) +
        0.03 * Math.sin(13 * a + 9 * l);
      path.push([1.7 * r * ripple * Math.cos(a), 0.86 * r * ripple * Math.sin(a)]);
    }
    geometry.push(path);
    level.push(l);
  }
  const data = new Patch('tides').replace('Contour', { count: contours }, { geometry, level });
  return {
    name: 'tides',
    alt: 'One hundred and ten closed contours swelling outward, from deep blue at the center to sand at the rim',
    data: [data],
    fit: framed([-640, -320, 640, 320]),
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: THEME,
      marks: [
        {
          lines: {
            of: ['tides', 'Contour'],
            width: 1.1,
            color: {
              colormap: {
                kind: 'sequential',
                colors: [
                  '#0b2545',
                  '#13607a',
                  '#2a9d8f',
                  '#8fc69a',
                  '#e9c46a',
                  '#f4a261',
                  '#e76f51',
                ],
              },
              value: '$level',
              domain: [0, 1],
            },
          },
        },
      ],
    },
  };
}
