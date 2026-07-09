# @latkit/monitor

WebGPU signal monitor for Latkit.

`@latkit/monitor` renders one selected signal from a packed time series into a
canvas owned by the monitor controller. It is designed for append-heavy data:
load a series once, mutate or replace the value buffer as frames commit, and call
`extend()` to paint only the new frontier.

```ts
import { createMonitor, type Series } from '@latkit/monitor';

const monitor = await createMonitor(container, {
  valueRange: [0, 1],
  colormap: (t) => [t, 0.5, 1 - t],
});

const series: Series = {
  time: Float64Array.from([0, 1, 2]),
  values: new Float32Array([0.1, 0.4, 0.2, 0.5, 0.3, 0.6]),
  signalCount: 1,
  elementCount: 2,
};

monitor.load(series);
```

`Series.values` is signal-major:

```ts
values[signal * time.length * elementCount + frame * elementCount + element];
```

Use `setSignal()` to switch signals, `setFocus()` to highlight one element, and
`on('hover', ...)` / `on('pick', ...)` to inspect the nearest reading under the
pointer. Call `destroy()` when the host removes the monitor.
