/** The grid: ACTIVSg70k's buses and branches over the states they stand in, drawn by voltage. */
import { fileURLToPath } from 'node:url';
import type { CustomColormap, Mark, Size } from 'latkit/core';
import { THEME, type Piece } from './look.ts';
import { readCase } from './grids.ts';

/** The states of the United States, which the CLI reads as GeoJSON. */
export const STATES = fileURLToPath(
  new URL('../../crates/latkit-cli/examples/branch-opening/states.geojson', import.meta.url),
);

/** Colors of the voltage levels, from below 100 kV to 765 kV: the higher, the hotter. */
export const LEVELS: CustomColormap = {
  kind: 'sequential',
  colors: ['#1c2e44', '#22507a', '#2d80b3', '#58bde6', '#ffcf73', '#fff4dc'],
};

/** Widths by voltage level, growing with its square: the backbone stands out of the rest. */
export const WIDTHS: Size = {
  scale: [0.3, 2.3],
  value: { op: 'mul', args: ['level', 'level'] },
  domain: [0, 25],
};

/** The states drawn beneath a grid: filled a shade above the ground, outlined faintly. */
export function states(outline = '#26364a'): Mark[] {
  return [
    { areas: { of: ['states', 'polygons'], color: '#0f1720', pick: false } },
    { lines: { of: ['states', 'polygons'], width: 0.6, color: outline } },
  ];
}

export default function grid(): Piece {
  const c = readCase('activsg70k');
  return {
    name: 'grid',
    alt: 'Seventy thousand buses of a synthetic grid on the United States, its lines colored and widened by voltage',
    data: [c.patch, { name: 'states', file: STATES }],
    // Over the grid from the south, tilted, so the backbone recedes toward the Great Lakes.
    camera: { center: [-84.2, 37.2], zoom: 4.38, pitch: 42, bearing: -8 },
    scene: {
      space: { earth: { projection: 'mercator', graticule: false, surface: THEME.background } },
      ease: 0,
      theme: THEME,
      marks: [
        ...states(),
        { vertices: { of: ['grid', 'Bus'], position: ['lon', 'lat'], radius: 0, pick: false } },
        {
          edges: {
            of: ['grid', 'Line'],
            ends: ['from', 'to'],
            priority: 'level',
            width: WIDTHS,
            color: { colormap: LEVELS, value: 'level', domain: [0, 5] },
          },
        },
      ],
    },
  };
}
