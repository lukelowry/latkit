import { createMonitor, type Monitor } from '../src/index.js';
import type { Gpu, kit } from '@latkit/gpu';
import type { Data } from '@latkit/model';
export function usage(
  gpu: Gpu,
  recording: Data,
  canvas: HTMLCanvasElement,
  color: kit.ColorScale,
): Monitor {
  const monitor = createMonitor(gpu, {
    canvas,
    at: 5,
    source: recording,
    traces: { temperature: { from: 'node', field: 'temperature', color } },
    camera: { window: [0, 10] },
    valueAxis: 'Temperature',
    hover: 'auto',
  });
  monitor.on('select', (readings) => monitor.fit(readings, { animate: true }));
  monitor.set({ camera: { follow: 10 }, traces: { temperature: { color: 'temperature' } } });
  // @ts-expect-error Frame preparation stays inside the view.
  void monitor.prepare;
  // @ts-expect-error Sources are borrowed, never closed by a view.
  void monitor.close;
  return monitor;
}
