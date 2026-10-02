# @latkit/gpu

The shared WebGPU owner every Latkit view renders with, plus compositions and colors.

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
```

One GPU serves every view. Destroy it after them. `gpu.stats()` reports managed memory and work;
limits fail with `resource-limit`.

## Write a view

Renderer authors build on the `kit` namespace: extend `kit.BaseView`, prepare GPU work in
`prepare`, encode it in `encode`, and react to config changes in `configure`. The base presents on
a canvas, schedules frames, attaches input, renders images, and keeps events. Frames provide native
field reads, uploads, text, colormaps, and transient buffers.

[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[Colors](https://latkit.readthedocs.io/en/latest/colormaps.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/gpu/index.html)
