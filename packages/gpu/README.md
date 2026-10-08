# @latkit/gpu

The shared WebGPU owner every Latkit view renders with, plus compositions and colors.

```sh
npm install @latkit/gpu
```

```ts
import { createGpu, createComposition } from '@latkit/gpu';

const gpu = await createGpu();
const dashboard = createComposition(gpu, {
  canvas,
  views: [
    { view: network, region: [0, 0, 1, 0.6] },
    { view: monitor, region: [0, 0.6, 1, 0.4] },
  ],
});

dashboard.destroy();
gpu.destroy(); // after its views
```

Renderer authors extend `kit.BaseView`, or `kit.BaseItemView` for views of selectable items. The
[architecture](https://latkit.readthedocs.io/en/latest/architecture.html) states the frame lifecycle
they implement.

[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[Colors](https://latkit.readthedocs.io/en/latest/colormaps.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/gpu/index.html)
