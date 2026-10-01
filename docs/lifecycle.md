# Lifecycle

Create a GPU owner, then renderers, then canvas views. Sources belong to your application.

```ts
const view = createCanvasView({ gpu, renderer, canvas, onError: console.error });
view.request({ at: 12, timeMs: 500 });
view.pause();
view.resume();
```

The view handles canvas sizing and schedules invalidated frames.
`at` uses model coordinates; `timeMs` controls animation.
Omitted request properties keep their previous values.

## Cleanup

Stop input and presentation before releasing rendering resources:

```ts
detachInput();
view.destroy();
renderer.destroy();
gpu.destroy();
await source.close();
```

A view does not destroy its renderer. A renderer does not close borrowed sources
or the shared GPU. Close sources only after their other consumers finish.

## Failures

Handle GPU creation errors and canvas `onError` in your application.
Managed resource limits reject with `resource-limit`.
Device loss invalidates the GPU owner: recreate it, the renderers, and views.

For deterministic output, retain the source and use
`gpu.render({ completion: 'complete', ... })` with fixed animation time.
