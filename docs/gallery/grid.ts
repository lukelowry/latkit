/** The grid: ACTIVSg70k's buses and branches over the US states, colored and sized by voltage. */
import fs from 'node:fs';
import { Data, field } from 'latkit';
import { readCase } from './grids.ts';
import type { Picture } from './render.ts';

export default async function (): Promise<Picture> {
  const { grid } = await readCase('activsg70k');
  const usa = new URL(
    '../../crates/latkit-cli/examples/branch-opening/states.geojson',
    import.meta.url,
  );
  const states = await Data.read(fs.readFileSync(usa), { name: 'states' });
  const level = field('level');
  return {
    scene: {
      space: { earth: { graticule: false } },
      ease: 0,
      theme: { background: '#0b0f14', earth: { ground: '#0b0f14' } },
      marks: [
        // The states, filled slightly lighter than the ground, with faint outlines.
        { areas: states.table('polygons'), color: '#0f1720', pick: false },
        { lines: states.table('polygons'), width: 0.6, color: '#26364a' },
        // The buses draw nothing: they only place the lines' ends.
        { vertices: grid.table('Bus'), position: ['$lon', '$lat'], radius: 0, pick: false },
        {
          edges: grid.table('Line'),
          ends: ['from', 'to'],
          priority: level,
          // Width grows with the level's square, so the high-voltage backbone stands out.
          width: level.mul(level).scale(0.3, 2.3).domain(0, 25),
          // The voltage levels, from below 100 kV to 765 kV. Higher levels are hotter colors.
          color: level
            .colormap({
              kind: 'sequential',
              colors: ['#1c2e44', '#22507a', '#2d80b3', '#58bde6', '#ffcf73', '#fff4dc'],
            })
            .domain(0, 5),
        },
      ],
    },
    // A tilted view from the south, so the backbone recedes toward the Great Lakes.
    camera: { center: [-84.2, 37.2], zoom: 4.38, pitch: 42, bearing: -8 },
  };
}
