# Create a monitor

WebGPU time-series plots over a sampled `Queryable`.

```ts
import { createGpu, createCanvasView } from '@latkit/gpu';
import { createMonitor, attachMonitorInput } from '@latkit/monitor';

const gpu = await createGpu();
const monitor = createMonitor({
  gpu,
  data: {
    source: recording,
    window: { kind: 'range', between: [0, 30] },
    traces: {
      temperature: { from: 'sensor', field: 'temperature', widthPx: 1.5 },
    },
  },
  options: {
    valueDomain: [0, 100],
    coordinateAxis: { label: 'Time (s)' },
    valueAxis: { label: 'Temperature' },
  },
});
const view = createCanvasView({ gpu, canvas, renderer: monitor, onError: console.error });
const detach = attachMonitorInput({ monitor, canvas });
view.request({ at: 12 });
monitor.on('select', (reading) => console.log(reading));
```

`recording` supplies sampled numeric `sensor.temperature` values.
Omit `rows` to show all covered rows, or select rows on each trace.

## Window and detail

```ts
monitor.setWindow({ kind: 'range', between: [30, 60] });
monitor.setOptions({ valueDomain: [10, 80] });
view.request({ at: 45 });
```

The playhead does not reload history. `detail: 'auto'` uses bounded
first/minimum/maximum/last summaries; `detail: 'full'` reads every observation.
Gaps remain gaps. All traces share the window and value domain.

Live sources publish appends. Set `follow: { span: 30 }` in options for a rolling
window. Hover and click report original observations. `hover: 'off'` disables
automatic hover reads; `hitTest` remains available.

## Cleanup

```ts
detach();
view.destroy();
monitor.destroy();
gpu.destroy();
await recording.close();
```

Renderers borrow their sources. For a fixed export, retain the source and use
a dedicated renderer with [video export](video.md).

[API](https://latkit.readthedocs.io/en/latest/api/reference/monitor/index.html)
