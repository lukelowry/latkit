/** Texas: ACTIVSg2000's generators sized by output, its highest-voltage lines carrying comets. */
import { THEME, type Piece } from './look.ts';
import { readCase } from './grids.ts';
import { LEVELS, STATES, WIDTHS, states } from './grid.ts';

export default function texas(): Piece {
  const c = readCase('activsg2000');
  return {
    name: 'texas',
    alt: 'Two thousand buses of a synthetic Texas grid: generators as amber discs sized by output, comets along its highest-voltage lines',
    data: [c.patch, { name: 'states', file: STATES }],
    camera: { center: [-98.7, 31.25], zoom: 5.6, pitch: 32, bearing: 0 },
    elapsed: 2,
    scene: {
      space: { earth: { projection: 'mercator', graticule: false, surface: THEME.background } },
      ease: 0,
      theme: {
        ...THEME,
        flow: { color: '#fff4dcd0', spacing: 0.9, length: 0.35, width: 3, units: true },
      },
      marks: [
        ...states('#2c3e54'),
        {
          edges: {
            of: ['grid', 'Line'],
            ends: ['from', 'to'],
            priority: 'level',
            width: WIDTHS,
            color: { colormap: LEVELS, value: 'level', domain: [0, 5] },
            flow: { when: [[{ op: 'ge', args: ['level', 3] }, 0.6]], otherwise: 0 },
          },
        },
        {
          vertices: {
            of: ['grid', 'Bus'],
            position: ['lon', 'lat'],
            radius: {
              scale: [0, 11],
              value: { op: 'sqrt', args: ['generation'] },
              domain: [0, 45],
            },
            color: '#ffb000',
            priority: 'generation',
            label: { text: 'name', size: 11, color: '#e6d7b8', priority: 'generation', max: 10 },
            visible: { op: 'gt', args: ['generation', 0] },
          },
        },
      ],
    },
  };
}
