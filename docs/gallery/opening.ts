/**
 * A line opening: ACTIVSg70k as its Little Rock to Newark 765 kV line opens. A DC power flow of the
 * whole grid shows where the line's power goes. Branches that pick it up are amber, branches that
 * lose flow are cyan, and the rest of the grid is a dim web. Each bus's height is its frequency
 * 2.5 s into a simulation of the same opening.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Patch, reference, type ExprInput } from 'latkit';
import { BASE, angles, flows, shifts } from './flow.ts';
import { readCase } from './grids.ts';
import { THEME, worldMap, type Piece } from './look.ts';
import { STATES } from './grid.ts';

/** Reads each bus's frequency deviation in hertz from the file `record.ts` writes. */
function frequency(): Float32Array {
  const file = fileURLToPath(new URL('opening.frequency.gz', import.meta.url));
  const bytes = gunzipSync(fs.readFileSync(file));
  const tenMicrohertz = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return Float32Array.from(tenMicrohertz, (v) => v * 1e-5);
}

export default async function opening(): Promise<Piece> {
  const c = await readCase('activsg70k');
  const [n, m] = [c.header.buses, c.header.branches];
  const number = c.array('bus.number', Uint32Array);
  const load = c.array('bus.load', Float32Array);
  const generation = c.array('bus.generation', Float32Array);
  const net = {
    buses: n,
    from: c.from,
    to: c.to,
    reactance: c.array('branch.reactance', Float32Array),
  };
  const [i, j] = [number.indexOf(59757), number.indexOf(59774)];
  const line = net.from.findIndex(
    (a, e) => (a === i && net.to[e] === j) || (a === j && net.to[e] === i),
  );
  // Injections in per unit, so the angles come out in radians.
  const theta = angles(
    net,
    Float64Array.from({ length: n }, (_, b) => (generation[b]! - load[b]!) / BASE),
  );
  const moved = flows(net, shifts(net, theta, line));
  // Each branch's change in flow magnitude once the line opens, as asinh(ΔMW / 4), so a change of a
  // few MW still shows.
  const gain = Float32Array.from(flows(net, theta), (before, e) =>
    Math.asinh((Math.abs(before + moved[e]!) - Math.abs(before)) / 4),
  );
  const level = c.lineLevel;
  const hz = frequency();
  // A pole to the ground from one bus of 345 kV or more in each 0.75° cell, so the heights are
  // readable without crowding the view with poles.
  const cells = new Set<string>();
  const pole = Float32Array.from({ length: n }, (_, b) => {
    const cell = `${Math.floor(c.lon[b]! / 0.75)} ${Math.floor(c.lat[b]! / 0.75)}`;
    if (c.kv[b]! < 345 || cells.has(cell)) return 0;
    cells.add(cell);
    return 1;
  });
  const data = new Patch('grid')
    .replace(
      'Bus',
      { count: n },
      {
        lon: c.lon,
        lat: c.lat,
        kv: c.kv,
        hz,
        // Height as a fraction of the earth's radius: zero at deviations of -16 mHz and below,
        // rising with frequency, with the highest peaks compressed by asinh.
        height: Float32Array.from(hz, (f) => 0.022 * Math.asinh(Math.max(0, f + 0.016) / 0.03)),
        pole,
      },
    )
    .replace(
      'Branch',
      { count: m },
      {
        from: reference('Bus', net.from),
        to: reference('Bus', net.to),
        gain,
        change: Float32Array.from(gain, Math.abs),
        level,
        // Width grows with voltage level, and with how far the flow change exceeds about 10 MW.
        width: Float32Array.from(
          gain,
          (g, e) => 0.45 + 0.12 * level[e]! + 0.3 * Math.max(0, Math.min(Math.abs(g), 6) - 1.7),
        ),
        open: Float32Array.from({ length: m }, (_, e) => (e === line ? 1 : 0)),
      },
    );
  const opened = (name: string, width: number, color: string) => ({
    edges: {
      of: ['grid', 'Branch'] as [string, string],
      ends: ['from', 'to'] as [string, string],
      name,
      width,
      color,
      visible: { op: 'eq' as const, args: ['open', 1] as [string, number] },
      pick: false,
    },
  });
  // Map lines are a light steel blue at low alpha, so they lighten whatever is beneath them.
  const map = (alpha: string) => `#7fa6cc${alpha}`;
  // Branches below 230 kV whose flow changes by less than about 10 MW, drawn dim and thin beneath
  // the rest.
  const quiet: ExprInput = {
    op: 'and',
    args: [
      { op: 'le', args: ['level', 1] },
      { op: 'lt', args: ['change', 1.7] },
    ],
  };
  return {
    name: 'opening',
    alt: 'The ACTIVSg70k grid on the globe as one 765 kV line opens: buses raised by their frequency, branches that pick up its power glow amber, those it leaves glow cyan',
    size: [2400, 1000],
    data: [
      data,
      { name: 'states', file: STATES },
      { name: 'coast', file: worldMap('coastline') },
      { name: 'borders', file: worldMap('countries') },
    ],
    // Low over the Gulf, looking north, the horizon a thin arc above the Great Lakes.
    camera: { center: [-85.5, 38.6], zoom: 5.1, pitch: 56, bearing: -6 },
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
        ...THEME,
        background: '#0f141a',
        grid: map('12'),
        earth: { ground: '#111a24', atmosphere: '#6a93c052', night: 0.35 },
      },
      marks: [
        { lines: { of: ['states', 'polygons'], width: 0.5, color: map('1f') } },
        { lines: { of: ['borders', 'lines'], width: 0.6, color: map('33') } },
        { lines: { of: ['coast', 'lines'], width: 0.7, color: map('4d') } },
        {
          vertices: {
            of: ['grid', 'Bus'],
            position: ['lon', 'lat'],
            elevation: 'height',
            radius: 0,
            color: '#00000000',
            pick: false,
          },
        },
        {
          edges: {
            of: ['grid', 'Bus'],
            poles: true,
            visible: { op: 'eq', args: ['pole', 1] },
            width: 0.35,
            color: '#a9b4bf33',
            pick: false,
          },
        },
        {
          edges: {
            of: ['grid', 'Branch'],
            ends: ['from', 'to'],
            name: 'web',
            width: 0.3,
            color: '#39414b',
            visible: { op: 'and', args: [{ op: 'eq', args: ['open', 0] }, quiet] },
            pick: false,
          },
        },
        {
          edges: {
            of: ['grid', 'Branch'],
            ends: ['from', 'to'],
            priority: 'change',
            width: 'width',
            color: {
              // Grey for changes within about 10 MW either way. Beyond that, cyan for less flow
              // and amber for more, at equal brightness.
              colormap: {
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
              },
              value: 'gain',
              domain: [-6, 6],
            },
            visible: {
              op: 'and',
              args: [
                { op: 'eq', args: ['open', 0] },
                { op: 'not', args: [quiet] },
              ],
            },
            pick: false,
          },
        },
        // The opened line as a faint red halo, a red line, and a pale core. It is the brightest
        // thing drawn.
        opened('halo', 10, '#ff2e4d2e'),
        opened('opened', 4.4, '#ff2e4d'),
        opened('core', 1.3, '#ffd6dd'),
      ],
    },
  };
}
