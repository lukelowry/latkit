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

Reads go through `gpu.reader`, the model `Reader` every view on this GPU shares. It reads into the
GPU's memory pool, so one `budget` bounds reads, uploads, and GPU resources together. `gpu.stats()`
exposes query and upload counts for measuring reuse. There is no
producer retention or replay.

## Write a view

Renderer authors build on the `kit` namespace and extend `kit.BaseView`:

- `resolve` turns a config into what the view draws from, once per config;
- `configure` reacts when a resolved config replaces the previous one;
- `prepare` reads and uploads, and returns what the frame draws;
- `encode` records that, and `submitted` commits what a presented frame shows.

The base presents on a canvas, schedules frames, attaches input, renders images, and keeps events.
Views of selectable items extend `kit.BaseItemView`, which adds the shared camera, selection,
picking, hover, clicks, `open`, shades, pipeline variants, limits, and option checks. The view
describes itself once (`kit.ItemShape`: its name, options, framed camera keys, input modes, and
style defaults) and supplies its camera math, hit search, `pipelines`, and own gestures; its
`prepare` calls `framePipelines`, `shadeFrame`, `frameCamera`, and `hoverFrame` once each. Frames provide the
GPU's reader (`frame.reader`), field uploads, text, colormaps, and transient buffers. A frame that
is not `presented` is an export, such as video: draw the view's state into it and change none of
it.

[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[Colors](https://latkit.readthedocs.io/en/latest/colormaps.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/gpu/index.html)

Uploads are keyed by the field blocks the reader returns, so a block the reader still holds uploads
once. Static fields and independently sampled fields keep separate dependencies; changed samples
do not gather or upload unchanged static fields.
