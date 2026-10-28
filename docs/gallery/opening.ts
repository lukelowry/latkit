/**
 * A line opening: ACTIVSg70k as its Little Rock to Newark 765 kV line opens. A DC power flow of the
 * whole grid shows where the line's power goes. Branches that pick it up are amber, branches that
 * lose flow are cyan, and the rest of the grid is a dim web. Each bus's height is its frequency
 * 2.5 s into a simulation of the same opening.
 */
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Data, field, type Mark } from 'latkit';
import { BASE, angles, flows, shifts } from './flow.ts';
import { readCase } from './grids.ts';
import type { Picture } from './render.ts';

/** Reads each bus's frequency deviation in hertz from the file `record.ts` writes. */
function frequency(): Float32Array {
  const bytes = gunzipSync(fs.readFileSync(new URL('opening.frequency.gz', import.meta.url)));
  const tenMicrohertz = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return Float32Array.from(tenMicrohertz, (v) => v * 1e-5);
}

export default async function (): Promise<Picture> {
  const c = await readCase('activsg70k');
  const { grid, lon, lat, kv, lineLevel: level } = c;
  const [n, m] = [c.header.buses, c.header.branches];
  const number = c.array('bus.number', Uint32Array);
  const load = c.array('bus.load', Float32Array);
  const generation = c.array('bus.generation', Float32Array);
  const reactance = c.array('branch.reactance', Float32Array);
  const net = { buses: n, from: c.from, to: c.to, reactance };
  const [i, j] = [number.indexOf(59757), number.indexOf(59774)];
  const line = net.from.findIndex(
    (a, e) => (a === i && net.to[e] === j) || (a === j && net.to[e] === i),
  );
  // Injections in per unit, so the angles come out in radians.
  const injection = Float64Array.from({ length: n }, (_, b) => (generation[b]! - load[b]!) / BASE);
  const theta = angles(net, injection);
  const moved = flows(net, shifts(net, theta, line));
  // Each branch's change in flow magnitude once the line opens, as asinh(ΔMW / 4), so a change of a
  // few MW still shows.
  const gain = Float32Array.from(flows(net, theta), (before, e) =>
    Math.asinh((Math.abs(before + moved[e]!) - Math.abs(before)) / 4),
  );
  const hz = frequency();
  // Height in degrees of arc: zero at deviations of -16 mHz and below, rising with frequency, with
  // the highest peaks compressed by asinh.
  const height = Float32Array.from(hz, (f) => 1.26 * Math.asinh(Math.max(0, f + 0.016) / 0.03));
  // A pole to the ground from one bus of 345 kV or more in each 0.75° cell, so the heights are
  // readable without crowding the view with poles.
  const cells = new Set<string>();
  const pole = Float32Array.from({ length: n }, (_, b) => {
    const cell = `${Math.floor(lon[b]! / 0.75)} ${Math.floor(lat[b]! / 0.75)}`;
    if (kv[b]! < 345 || cells.has(cell)) return 0;
    cells.add(cell);
    return 1;
  });
  // Width grows with voltage level, and with how far the flow change exceeds about 10 MW.
  const width = Float32Array.from(
    gain,
    (g, e) => 0.45 + 0.12 * level[e]! + 0.3 * Math.max(0, Math.min(Math.abs(g), 6) - 1.7),
  );
  const open = Float32Array.from({ length: m }, (_, e) => (e === line ? 1 : 0));
  grid
    .set('Bus', { hz, height, pole })
    .set('Line', { gain, change: Float32Array.from(gain, Math.abs), width, open });

  const usa = new URL(
    '../../crates/latkit-cli/examples/branch-opening/states.geojson',
    import.meta.url,
  );
  const maps = new URL('../../npm/examples/public/maps/', import.meta.url);
  const coastline = fs.readFileSync(new URL('coastline.geojson.gz', maps));
  const countries = fs.readFileSync(new URL('countries.geojson.gz', maps));
  const states = await Data.read(fs.readFileSync(usa), { name: 'states' });
  const coast = await Data.read(coastline, { name: 'coast' });
  const borders = await Data.read(countries, { name: 'borders' });

  const opened = (name: string, width: number, color: string): Mark => ({
    edges: grid.table('Line'),
    ends: ['from', 'to'],
    name,
    width,
    color,
    visible: field('open').eq(1),
    pick: false,
  });
  // Map lines are a light steel blue at low alpha, so they lighten whatever is beneath them.
  const map = (alpha: string) => `#7fa6cc${alpha}`;
  // Branches below 230 kV whose flow changes by less than about 10 MW, drawn dim and thin beneath
  // the rest.
  const quiet = field('level').le(1).and(field('change').lt(1.7));
  const closed = field('open').eq(0);
  return {
    scene: {
      space: {
        earth: {
          projection: 'globe',
          graticule: true,
          atmosphere: true,
          // Dusk at the September equinox. The sun is setting over the western grid, and it is
          // night over the Atlantic.
          daylight: Date.UTC(2026, 8, 22, 22, 20) / 1000,
        },
      },
      ease: 0,
      // The docs page's background, a muted steel atmosphere rather than the cyan of the flow
      // changes, a faint graticule, and a night shade light enough to keep the grid readable.
      theme: {
        background: '#0f141a',
        grid: map('12'),
        earth: { ground: '#111a24', atmosphere: '#6a93c052', night: 0.35 },
      },
      marks: [
        { lines: states.table('polygons'), width: 0.5, color: map('1f') },
        { lines: borders.table('lines'), width: 0.6, color: map('33') },
        { lines: coast.table('lines'), width: 0.7, color: map('4d') },
        // The buses draw nothing: they raise the branches' ends to their heights.
        {
          vertices: grid.table('Bus'),
          position: ['$lon', '$lat'],
          elevation: '$height',
          radius: 0,
          color: '#00000000',
          pick: false,
        },
        {
          edges: grid.table('Bus'),
          poles: true,
          visible: field('pole').eq(1),
          width: 0.35,
          color: '#a9b4bf33',
          pick: false,
        },
        {
          edges: grid.table('Line'),
          ends: ['from', 'to'],
          name: 'web',
          width: 0.3,
          color: '#39414b',
          visible: closed.and(quiet),
          pick: false,
        },
        {
          edges: grid.table('Line'),
          ends: ['from', 'to'],
          priority: '$change',
          width: '$width',
          // Grey for changes within about 10 MW either way. Beyond that, cyan for less flow and
          // amber for more, at equal brightness.
          color: field('gain')
            .colormap({
              kind: 'diverging',
              colors: [
                [0, '#a8e6ff'],
                [0.14, '#4cc4f0'],
                [0.27, '#3a8db5'],
                [0.36, '#6c7784'],
                [0.64, '#6c7784'],
                [0.73, '#b07a3a'],
                [0.86, '#f2a13a'],
                [1, '#ffd27a'],
              ],
            })
            .domain(-6, 6),
          visible: closed.and(quiet.not()),
          pick: false,
        },
        // The opened line as a faint red halo, a red line, and a pale core. It is the brightest
        // thing drawn.
        opened('halo', 10, '#ff2e4d2e'),
        opened('opened', 4.4, '#ff2e4d'),
        opened('core', 1.3, '#ffd6dd'),
      ],
    },
    // Low over the Gulf, looking north, the horizon a thin arc above the Great Lakes.
    camera: { center: [-85.5, 38.6], zoom: 5.1, pitch: 56, bearing: -6 },
    size: [2400, 1000],
  };
}
