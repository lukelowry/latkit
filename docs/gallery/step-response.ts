/** An illustrative first-order response to two changes in active power setpoint. */
import { Data } from 'latkit';
import type { Picture } from './render.ts';

export default function (): Picture {
  const times = Array.from({ length: 241 }, (_, i) => i / 10);
  const target = times.map((t) => (t < 3 ? 40 : t < 14 ? 80 : 55));
  const response: number[] = [target[0]!];
  for (let i = 1; i < times.length; i++) {
    const previousTarget = target[i - 1]!;
    response.push(previousTarget + (response[i - 1]! - previousTarget) * Math.exp(-0.1 / 2));
  }
  const run = new Data('run').replace('Unit', { name: ['G1'] });
  run.axis('time', 's').append('Unit', times, { target, response });
  const lines = run.table('Unit');

  return {
    size: [1200, 720],
    camera: { x: [0, 24], y: [30, 90] },
    scene: {
      space: {
        plot: {
          x: { label: 'Time (s)', ticks: [0, 4, 8, 12, 16, 20, 24], grid: false },
          y: { label: 'Active power (MW)', ticks: [30, 40, 50, 60, 70, 80, 90] },
        },
      },
      title: { text: 'Setpoint tracking', subtitle: 'Dashed: command    Solid: output' },
      theme: {
        background: '#101923',
        text: { color: '#e2eaf1', size: 13, halo: 0 },
        grid: { color: '#334454' },
        plot: { playhead: '#00000000' },
      },
      marks: [
        {
          lines,
          trace: 'target',
          interpolation: 'stepAfter',
          width: 1.8,
          dash: true,
          color: '#ffca86',
        },
        { lines, trace: 'response', width: 2.6, color: '#80c7ff' },
      ],
    },
  };
}
