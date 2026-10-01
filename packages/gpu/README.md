# @latkit/gpu

Shared WebGPU rendering, native fields, text, colors, and resource management.

## Display a renderer

```ts
import { createGpu, createCanvasView } from '@latkit/gpu';

const gpu = await createGpu();
const renderer = createYourRenderer(gpu);
const view = createCanvasView({ gpu, renderer, canvas, onError: console.error });
view.request({ at: 12 });

view.pause();
view.resume();

// On teardown:
view.destroy();
renderer.destroy();
gpu.destroy();
```

`createYourRenderer` is your factory, such as a configured network or monitor.
The view borrows the renderer and GPU. Give the canvas an explicit CSS size.

## Render offscreen

```ts
import { createRenderTarget } from '@latkit/gpu';

const target = createRenderTarget({ gpu, width: 1920, height: 1080 });
try {
  await gpu.render({
    views: [{ renderer, target, at: 12 }],
    timeMs: 0,
    completion: 'complete',
  });
  await gpu.idle();
} finally {
  target.destroy();
}
```

`at` is a model coordinate; `timeMs` is animation time.
`completion: 'complete'` drains progressive preparation before final output.
Retain source data when output must stay fixed.

## Compose views

```ts
import { createComposition } from '@latkit/gpu';

const combined = createComposition({
  gpu,
  views: [
    { renderer: network, region: { x: 0, y: 0, width: 1, height: 0.6 } },
    { renderer: monitor, region: { x: 0, y: 0.6, width: 1, height: 0.4 } },
  ],
});
```

Regions are normalized with a top-left origin. Destroy the composition separately
from its children.

## Implement a renderer

A `Renderer` prepares resources asynchronously, encodes commands synchronously,
and releases its own resources in `destroy()`. GPU owns submission.
Use `submitted()` to publish picking state only after a successful submission.

Use frame methods for fields, uploads, text, colormaps, buffers, and textures.
Frame descriptors expire with the frame. Reuse immutable input identities to reuse
cached resources. `BufferData` and `TextureData` track mutable application data.

`gpu.stats()` reports managed storage and work. Limits fail with
`resource-limit`; device loss requires recreating the GPU and renderers.

[Colors](../../docs/colormaps.md) ?
[Lifecycle](../../docs/lifecycle.md) ?
[API](https://latkit.readthedocs.io/en/latest/api/reference/gpu/index.html)
