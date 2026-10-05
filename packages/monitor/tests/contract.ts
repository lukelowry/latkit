import { createMonitor, type Monitor } from '../src/index.js';
import type { Gpu, ColorScale } from '@latkit/gpu';
import type { Data } from '@latkit/model';
export function usage(
  gpu: Gpu,
  recording: Data,
  canvas: HTMLCanvasElement,
  color: ColorScale,
): Monitor {
  const monitor = createMonitor(gpu, {
    canvas,
    at: 5,
    source: recording,
    traces: { temperature: { from: 'node', y: 'temperature', color } },
    camera: { x: [0, 10] },
    yAxis: 'Temperature',
    hover: 'auto',
  });
  monitor.on('select', (readings) => monitor.fit(readings, { animate: true }));
  monitor.set({ camera: { x: [5, 15] }, traces: { temperature: { color: 'temperature' } } });
  // @ts-expect-error Frame preparation stays inside the view.
  void monitor.prepare;
  // @ts-expect-error Sources are borrowed, never closed by a view.
  void monitor.close;
  return monitor;
}
