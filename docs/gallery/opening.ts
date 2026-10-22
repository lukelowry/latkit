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
  const lift = Number(process.env.HERO_LIFT ?? 0.025);
  // A stalk down to the ground from each bus of 345 kV and up, so its height reads.
  const tall = Array.from({ length: n }, (_, b) => b).filter((b) => kv[b]! >= Number(process.env.HERO_KV ?? 345));
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
          b < n ? lift * Math.asinh(Math.max(0, hz[b]! + 0.016) / 0.03) : 0,
        ),
      },
    )
    .replace(
      'Stalk',
      { count: tall.length },
      {
        from: reference('Bus', Uint32Array.from(tall)),
        to: reference('Bus', Uint32Array.from(tall, (_, k) => n + k)),
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
        // Wider by voltage, and by how much the branch's flow changed.
        width: Float32Array.from(gain, (g, e) => 0.28 + 0.1 * level[e]! + 0.2 * Math.abs(g)),
        open: Float32Array.from({ length: m }, (_, e) => (e === line ? 1 : 0)),
      },
    );
  const camera = process.env.HERO_CAM
    ? (JSON.parse(process.env.HERO_CAM) as Piece['camera'])
    : { center: [-86, 34.5], zoom: 4.3, pitch: 58, bearing: -12 };
  return {
    name: 'opening',
    alt: 'The ACTIVSg70k grid on the globe as one 765 kV line opens: buses raised by their frequency, branches that pick up its power glow amber, those it leaves glow blue',
    size: [2400, 1000],
    data: [
      data,
      { name: 'states', file: STATES },
      { name: 'coast', file: worldMap('coastline') },
      { name: 'borders', file: worldMap('countries') },
    ],
    camera,
    scene: {
      space: {
        earth: { projection: 'globe', surface: '#0c131b', graticule: false, atmosphere: true },
      },
      ease: 0,
      theme: THEME,
      marks: [
        { lines: { of: ['borders', 'lines'], width: 0.6, color: '#253a50' } },
        { lines: { of: ['states', 'polygons'], width: 0.5, color: '#1d2d3e' } },
        { lines: { of: ['coast', 'lines'], width: 0.8, color: '#33587a' } },
        {
          vertices: {
            of: ['grid', 'Bus'],
            position: ['lon', 'lat'],
            elevation: 'height',
            radius: 0,
            pick: false,
          },
        },
        {
          edges: {
            of: ['grid', 'Stalk'],
            ends: ['from', 'to'],
            width: 0.5,
            color: '#5b86ad40',
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
              colormap: {
                kind: 'diverging',
                colors: ['#a6dcff', '#4a9be0', '#2b5a7c', '#34495a', '#73502c', '#e09238', '#ffd98a'],
              },
              value: 'gain',
              domain: [-6, 6],
            },
            visible: { op: 'eq', args: ['open', 0] },
            pick: false,
          },
        },
        {
          edges: {
            of: ['grid', 'Branch'],
            ends: ['from', 'to'],
            name: 'opened',
            width: 3.2,
            color: '#ff3b3b',
            visible: { op: 'eq', args: ['open', 1] },
            pick: false,
          },
        },
      ],
    },
  };
}
