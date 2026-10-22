/**
 * A line opening: ACTIVSg70k as its Little Rock to Newark 765 kV line opens. A DC power flow of the
 * whole grid finds where the line's power goes: the branches that pick it up glow amber, those it
 * leaves glow blue, and the rest of the grid stays a quiet web.
 */
import { Patch, reference } from 'latkit/core';
import { angles, shifts } from './flow.ts';
import { levelOf, readCase } from './grids.ts';
import { THEME, type Piece } from './look.ts';

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
  const data = Patch.to('grid')
    .replace(
      'Bus',
      { count: n },
      {
        x: Float64Array.from({ length: n }, (_, b) => c.positions[2 * b]!),
        y: Float64Array.from({ length: n }, (_, b) => c.positions[2 * b + 1]!),
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
  return {
    name: 'opening',
    alt: 'The ACTIVSg70k grid as one 765 kV line opens: branches that pick up its power glow amber, those it leaves glow blue, across a quiet web of 88,000 branches',
    data: [data],
    camera: { center: [-85.7, 36.4, 0], zoom: 4.28, pitch: 52, bearing: -16 },
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: THEME,
      marks: [
        { vertices: { of: ['grid', 'Bus'], position: ['x', 'y'], radius: 0, pick: false } },
        {
          edges: {
            of: ['grid', 'Branch'],
            ends: ['from', 'to'],
            priority: 'change',
            width: 'width',
            color: {
              colormap: {
                kind: 'diverging',
                colors: [
                  '#a6dcff',
                  '#4a9be0',
                  '#2b5a7c',
                  '#34495a',
                  '#73502c',
                  '#e09238',
                  '#ffd98a',
                ],
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
            width: 2.4,
            color: '#ffffff',
            dash: true,
            visible: { op: 'eq', args: ['open', 1] },
            pick: false,
          },
        },
      ],
    },
  };
}
