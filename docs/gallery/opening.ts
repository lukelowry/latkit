/**
 * A line opening: ACTIVSg70k as its Little Rock to Newark 765 kV line opens. A DC power flow of the
 * whole grid finds where the line's power goes: the branches that pick it up glow amber, those it
 * leaves glow blue, and the rest of the grid stays a quiet web. Each bus stands as high as its
 * frequency, recorded 2.5 s into a simulation of the same opening.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Patch, reference } from 'latkit/core';
import { angles, shifts } from './flow.ts';
import { levelOf, readCase } from './grids.ts';
import { THEME, worldMap, type Piece } from './look.ts';
import { STATES } from './grid.ts';

/** Each bus's frequency deviation in hertz, as `record.ts` wrote it. */
function frequency(): Float32Array {
  const file = fileURLToPath(new URL('opening.frequency.gz', import.meta.url));
  const bytes = gunzipSync(fs.readFileSync(file));
  const tenMicrohertz = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return Float32Array.from(tenMicrohertz, (v) => v * 1e-5);
}

export default function opening(): Piece {
  const c = readCase('activsg70k');
  const [n, m] = [c.header.buses, c.header.branches];
  const ends = c.array('branch.ends', Uint32Array);
  const kv = c.array('bus.kv', Float32Array);
  const number = c.array('bus.number', Uint32Array);
  const load = c.array('bus.load', Float32Array);
  const generation = c.array('bus.generation', Float32Array);
  const net = {
    buses: n,
    from: Uint32Array.from({ length: m }, (_, e) => ends[2 * e]!),
    to: Uint32Array.from({ length: m }, (_, e) => ends[2 * e + 1]!),
    reactance: c.array('branch.reactance', Float32Array),
  };
  const [i, j] = [number.indexOf(59757), number.indexOf(59774)];
  const line = net.from.findIndex(
    (a, e) => (a === i && net.to[e] === j) || (a === j && net.to[e] === i),
  );
  // Injections on a 100 MVA base, so the angles come out in radians.
  const theta = angles(
    net,
    Float64Array.from({ length: n }, (_, b) => (generation[b]! - load[b]!) / 100),
  );
  const shift = shifts(net, theta, line);
  const mw = (e: number, angle: Float64Array) =>
    ((angle[net.from[e]!]! - angle[net.to[e]!]!) * 100) /
    Math.max(Math.abs(net.reactance[e]!), 1e-4);
  // What each branch picks up once the line is open, in MW, compressed so a few MW still shows.
  const gain = Float32Array.from({ length: m }, (_, e) => {
    const before = mw(e, theta);
    return Math.asinh((Math.abs(before + mw(e, shift)) - Math.abs(before)) / 4);
  });
  const level = Float32Array.from({ length: m }, (_, e) =>
    levelOf(Math.max(kv[net.from[e]!]!, kv[net.to[e]!]!)),
  );
  const hz = frequency();
  // A stalk down to the ground from one bus of 345 kV and up in each cell of 3/4 degree, so the
  // height reads without a curtain of them.
  const cells = new Set<string>();
  const tall = Array.from({ length: n }, (_, b) => b).filter((b) => {
    if (kv[b]! < 345) return false;
    const cell = `${Math.floor(c.positions[2 * b]! / 0.75)} ${Math.floor(c.positions[2 * b + 1]! / 0.75)}`;
    return !cells.has(cell) && cells.add(cell) !== undefined;
  });
  const all = n + tall.length;
  const bus = (b: number) => (b < n ? b : tall[b - n]!);
  const data = Patch.to('grid')
    .replace(
      'Bus',
      { count: all },
      {
        lon: Float64Array.from({ length: all }, (_, b) => c.positions[2 * bus(b)]!),
        lat: Float64Array.from({ length: all }, (_, b) => c.positions[2 * bus(b) + 1]!),
        // A fraction of the earth's radius: on the ground at the lowest frequencies, rising with
        // the frequency, the highest peaks compressed. Each stalk's foot stays on the ground.
        height: Float32Array.from({ length: all }, (_, b) =>
          b < n ? 0.022 * Math.asinh(Math.max(0, hz[b]! + 0.016) / 0.03) : 0,
        ),
      },
    )
    .replace(
      'Stalk',
      { count: tall.length },
      {
        from: reference('Bus', Uint32Array.from(tall)),
        to: reference(
          'Bus',
          Uint32Array.from(tall, (_, k) => n + k),
        ),
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
        // Wider by voltage, and by how far past a quiet 10 MW the branch's flow changed.
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
  // Map lines are a light steel at low alpha, so they lighten whatever lies under them.
  const map = (alpha: string) => `#7fa6cc${alpha}`;
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
        earth: { projection: 'globe', surface: '#111a24', graticule: false, atmosphere: true },
      },
      ease: 0,
      // The docs page's own ground, and air a muted steel rather than the event's cyan.
      theme: { ...THEME, background: '#0f141a', atmosphere: '#6a93c052' },
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
            of: ['grid', 'Stalk'],
            ends: ['from', 'to'],
            width: 0.35,
            color: '#a9b4bf33',
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
              // A quiet grey within 10 MW either way; past it, cyan and amber of equal brightness.
              colormap: {
                kind: 'diverging',
                colors: [
                  [0, '#a8e6ff'],
                  [0.14, '#4cc4f0'],
                  [0.27, '#3a8db5'],
                  [0.36, '#5e6874'],
                  [0.64, '#5e6874'],
                  [0.73, '#b07a3a'],
                  [0.86, '#f2a13a'],
                  [1, '#ffd27a'],
                ],
              },
              value: 'gain',
              domain: [-6, 6],
            },
            visible: { op: 'eq', args: ['open', 0] },
            pick: false,
          },
        },
        // The opened line: a dark casing, red, and a bright core, the brightest thing drawn.
        opened('casing', 8, '#0b0f14cc'),
        opened('opened', 3.4, '#ff2e4d'),
        opened('core', 1.1, '#ffd6dd'),
      ],
    },
  };
}
