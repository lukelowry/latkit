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

## Sampled playback

Keep passing the desired coordinate with `view.set({ at })`. Field reads, local queries, and
automatic scale domains reuse results when that coordinate selects the same immutable observations.
Each field resolves its own coordinates. Appending samples preserves reuse of unchanged observations;
new samples at the playhead, including duplicate coordinates, invalidate the affected reads.

This works with named fields, explicit row indices, and ID selections without cache configuration.
Cached blocks report the current data version. `gpu.stats()` exposes query and upload counts for
measuring reuse. Caches remain subject to the existing GPU owner's resource budget; there is no
producer retention or replay.

## Write a view

Renderer authors build on the `kit` namespace: extend `kit.BaseView`, prepare GPU work in
`prepare`, encode it in `encode`, and react to config changes in `configure`. The base presents on
a canvas, schedules frames, attaches input, renders images, and keeps events. Frames provide native
field reads, uploads, text, colormaps, and transient buffers.

[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[Colors](https://latkit.readthedocs.io/en/latest/colormaps.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/gpu/index.html)
