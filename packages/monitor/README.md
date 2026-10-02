# @latkit/monitor

Plot sampled fields over a coordinate such as time with WebGPU, live as frames append.

```ts
import { createGpu } from '@latkit/gpu';
import { createMonitor } from '@latkit/monitor';

const gpu = await createGpu();
const monitor = createMonitor(gpu, {
  canvas,
  source: observations,
  traces: { temperature: { from: 'sensor', field: 'temperature' } },
  camera: { window: [0, 30], follow: 30 },
  valueAxis: 'Temperature',
});
```

Supply each application update with `monitor.set({ source: nextData })`. Shared unchanged
pages preserve incremental rendering; the application decides how much history to keep.

[Guide](https://latkit.readthedocs.io/en/latest/monitor-quickstart.html) ·
[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/monitor/index.html)
