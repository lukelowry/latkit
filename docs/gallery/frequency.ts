/** Frequency: the speed of every machine in ACTIVSg10k after a fault, traced over time. */
import { field } from 'latkit';
import { readCase } from './grids.ts';
import type { Picture } from './render.ts';

export default async function (): Promise<Picture> {
  const { grid, header, lon, lat, machineBus, simulation } = await readCase('activsg10k');
  const fault = header.fault!;
  const [fx, fy] = [lon[fault.bus]!, lat[fault.bus]!];
  // Each machine's distance from the fault in degrees. The disturbance reaches near machines first.
  const distance = Float32Array.from(machineBus, (b) => Math.hypot(lon[b]! - fx, lat[b]! - fy));
  grid.set('Machine', { distance });
  return {
    scene: {
      space: { plot: { x: { label: 'Time (s)' }, y: { label: 'Speed (mHz from 60 Hz)' } } },
      ease: 0,
      // The dark theme, with a darker background and labels without halos.
      theme: {
        background: '#0b0f14',
        text: { color: '#c3ccd6', font: 'sans-serif', size: 12, halo: 0 },
      },
      marks: [
        {
          lines: grid.table('Machine'),
          trace: 'speed',
          // The nearest machines, which swing hardest, draw on top.
          priority: field('distance').neg(),
          width: 0.7,
          color: field('distance')
            .colormap({
              kind: 'sequential',
              colors: ['#fff1c9', '#ffb36b', '#e8577a', '#7a3fc4', '#24366e'],
            })
            .domain(0, 9),
        },
      ],
    },
    // x spans the whole recording. With `y` null, the speed range fits what is in view.
    camera: { x: [0, simulation!.duration], y: null },
  };
}
