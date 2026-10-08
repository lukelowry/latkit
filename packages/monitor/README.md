# @latkit/monitor

Plot sampled fields over a coordinate such as time with WebGPU, live as frames append.

```sh
npm install @latkit/model @latkit/gpu @latkit/monitor
```

```ts
import { createGpu } from '@latkit/gpu';
import { appendData } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';

const gpu = await createGpu();
const monitor = createMonitor(gpu, {
  canvas,
  source: observations,
  traces: { temperature: { from: 'sensor', y: 'temperature' } },
  camera: { x: [0, 30] },
  yAxis: 'Temperature',
});
monitor.set({ source: appendData(observations, samples) });
```

[Guide](https://latkit.readthedocs.io/en/latest/monitor-quickstart.html) ·
[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/monitor/index.html)
