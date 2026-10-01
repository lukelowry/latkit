import { createMonitor, attachMonitorInput } from '../src/index.js';
import { createCanvasView, type Gpu, type Renderer, type ColorScale } from '@latkit/gpu';
import type { Queryable } from '@latkit/model';
export function usage(
  gpu: Gpu,
  recording: Queryable,
  canvas: HTMLCanvasElement,
  color: ColorScale,
): Renderer {
  const monitor = createMonitor({
    gpu,
    data: {
      source: recording,
      window: { kind: 'range', between: [0, 10] },
      traces: { temperature: { from: 'node', field: 'temperature', color } },
    },
    options: { hover: 'auto', hoverBudgetMs: 2 },
  });
  const view = createCanvasView({ gpu, renderer: monitor, canvas, onError: console.error });
  view.request({ at: 5 });
  attachMonitorInput({ monitor, canvas });
  monitor.on('select', (reading) => {
    if (reading) monitor.select(reading);
  });
  // @ts-expect-error Model ownership and acquisition are outside a renderer.
  void monitor.close;
  // @ts-expect-error No exported snapshot data pipeline.
  void monitor.snapshot;
  return monitor;
}
