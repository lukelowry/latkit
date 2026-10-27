/** Texas: ACTIVSg2000's generators sized by output, with comets on its lines of 345 kV and up. */
import fs from 'node:fs';
import { Data, field, units, when } from 'latkit';
import { readCase } from './grids.ts';
import type { Picture } from './render.ts';

export default async function (): Promise<Picture> {
  const { grid, array } = await readCase('activsg2000');
  const usa = new URL(
    '../../crates/latkit-cli/examples/branch-opening/states.geojson',
    import.meta.url,
  );
  const states = await Data.read(fs.readFileSync(usa), { name: 'states' });
  // The largest generators are named: those making at least as much as the tenth largest.
  const generation = Array.from(array('bus.generation', Float32Array)).sort((p, q) => q - p);
  const named = generation[9] ?? 0;
  const level = field('level');
  return {
    scene: {
      space: { earth: { graticule: false } },
      ease: 0,
      // The dark theme, with a darker background and labels without halos.
      theme: {
        background: '#0b0f14',
        text: { color: '#c3ccd6', font: 'sans-serif', size: 12, halo: 0 },
        earth: { ground: '#0b0f14' },
        flow: { color: '#fff4dcd0', spacing: units(0.9), length: units(0.35), width: 3 },
      },
      marks: [
        // The states, filled slightly lighter than the ground, with faint outlines.
        { areas: states.table('polygons'), color: '#0f1720', pick: false },
        { lines: states.table('polygons'), width: 0.6, color: '#2c3e54' },
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
          flow: when(level.ge(3)).then(0.6).otherwise(0),
        },
        {
          vertices: grid.table('Bus'),
          position: ['$lon', '$lat'],
          radius: field('generation').sqrt().scale(0, 11).domain(0, 45),
          color: '#ffb000',
          priority: '$generation',
          label: {
            text: when(field('generation').ge(named)).then('$name').otherwise(null),
            size: 11,
            color: '#e6d7b8',
          },
          visible: field('generation').gt(0),
        },
      ],
    },
    camera: { center: [-98.7, 31.25], zoom: 5.6, pitch: 32, bearing: 0 },
    elapsed: 2,
  };
}
