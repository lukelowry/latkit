/** The grid: ACTIVSg70k's buses and branches over the US states, colored and sized by voltage. */
import { fileURLToPath } from 'node:url';
import type { CustomColormap, Mark, Size } from 'latkit';
import { THEME, type Piece } from './look.ts';
import { readCase } from './grids.ts';

/** Path of the US states as GeoJSON, which the CLI reads directly. */
export const STATES = fileURLToPath(
  new URL('../../crates/latkit-cli/examples/branch-opening/states.geojson', import.meta.url),
);

/** Colormap of the voltage levels, from below 100 kV to 765 kV. Higher levels are hotter colors. */
export const LEVELS: CustomColormap = {
  kind: 'sequential',
  colors: ['#1c2e44', '#22507a', '#2d80b3', '#58bde6', '#ffcf73', '#fff4dc'],
};

/** Line width by voltage level, growing with the level's square so the high-voltage backbone
 * stands out. */
export const WIDTHS: Size = {
  scale: [0.3, 2.3],
  value: { op: 'mul', args: ['level', 'level'] },
  domain: [0, 25],
};

/** Marks that draw the states beneath a grid: filled slightly lighter than the ground, with faint
 * outlines. */
export function states(outline = '#26364a'): Mark[] {
  return [
    { areas: { of: ['states', 'polygons'], color: '#0f1720', pick: false } },
    { lines: { of: ['states', 'polygons'], width: 0.6, color: outline } },
  ];
}

export default async function grid(): Promise<Piece> {
  const c = await readCase('activsg70k');
  return {
    name: 'grid',
    alt: 'Seventy thousand buses of a synthetic grid on the United States, its lines colored and widened by voltage',
    data: [c.patch, { name: 'states', file: STATES }],
    // A tilted view from the south, so the backbone recedes toward the Great Lakes.
    camera: { center: [-84.2, 37.2], zoom: 4.38, pitch: 42, bearing: -8 },
    scene: {
      space: { earth: { graticule: false } },
      ease: 0,
      theme: { ...THEME, earth: { ground: THEME.background } },
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
