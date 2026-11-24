import { Data } from 'latkit';
import type { Picture } from './render.ts';

export interface Recording {
  times: number[];
  bus_ids: number[];
}

/** Extract one bus from the recording's frame-major, little-endian voltage samples. */
export function voltageDip({ times, bus_ids }: Recording, bytes: DataView): Picture {
  const bus = bus_ids.indexOf(4005);
  if (bus < 0) throw new Error('The recording contains no bus 4005.');
  const vm = times.map((_, frame) => bytes.getFloat32(4 * (frame * bus_ids.length + bus), true));
  const grid = new Data('grid').replace('Bus', { name: ['John Day'] });
  grid.axis('time', 's').append('Bus', times, { vm });

  return {
    size: [1200, 720],
    camera: { x: [0.8, 1.6], y: [0.9, 1.1] },
    scene: {
      space: {
        plot: {
          x: {
            label: 'Time (s)',
            ticks: [0.8, [1, '1.00 · fault'], [1.15, '1.15 · clear'], 1.4, 1.6],
          },
          y: { label: 'Voltage (p.u.)', ticks: [0.9, 0.95, 1, 1.05, 1.1], precision: 2 },
        },
      },
      title: { text: 'John Day', subtitle: 'Bus 4005 · WECC240' },
      theme: {
        background: '#101923',
        text: { color: '#e2eaf1', size: 13, halo: 0 },
        grid: { color: '#334454' },
        plot: { playhead: '#00000000' },
      },
      marks: [{ lines: grid.table('Bus'), trace: 'vm', width: 2.5, color: '#6edac9' }],
    },
  };
}
