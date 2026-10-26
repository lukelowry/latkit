/** Frequency: the speed of every machine in ACTIVSg10k after a fault, traced over time. */
import { THEME, type Piece } from './look.ts';
import { readCase } from './grids.ts';

export default function frequency(): Piece {
  const c = readCase('activsg10k');
  const fault = c.header.fault!;
  const [fx, fy] = [c.positions[2 * fault.bus]!, c.positions[2 * fault.bus + 1]!];
  // Each machine's distance from the fault in degrees. The disturbance reaches near machines first.
  const distance = Float32Array.from(c.machineBus, (b) =>
    Math.hypot(c.positions[2 * b]! - fx, c.positions[2 * b + 1]! - fy),
  );
  c.patch.set('Machine', { count: c.header.machines }, { distance });
  const machines = c.header.machines.toLocaleString('en-US');
  return {
    name: 'frequency',
    alt: `The speed of ${machines} machines over ten seconds after a fault, near ones bright and swinging hardest, far ones dark`,
    data: [c.patch],
    // x spans the whole recording. With `y` null, the speed range fits what is in view.
    camera: { x: [0, (c.header.frames! - 1) * c.header.dt!], y: null },
    scene: {
      space: { plot: { x: { label: 'Time (s)' }, y: { label: 'Speed (mHz from 60 Hz)' } } },
      ease: 0,
      theme: THEME,
      marks: [
        {
          lines: {
            of: ['grid', 'Machine'],
            trace: 'speed',
            // The nearest machines, which swing hardest, draw on top.
            priority: { op: 'neg', args: ['distance'] },
            width: 0.7,
            color: {
              colormap: {
                kind: 'sequential',
                colors: ['#fff1c9', '#ffb36b', '#e8577a', '#7a3fc4', '#24366e'],
              },
              value: 'distance',
              domain: [0, 9],
            },
          },
        },
      ],
    },
  };
}
