# Views

A network, monitor, diagram, or composition is a view: one object, created from a GPU and a config,
updated with `set`, and destroyed when done.

```ts
import { createGpu } from '@latkit/gpu';
import { createNetwork } from '@latkit/network';

const gpu = await createGpu();
const network = createNetwork(gpu, { canvas, source, vertices: { Bus: {} } });
```

## Present

With a `canvas`, the view draws itself. It sizes the canvas to its CSS size and pixel ratio, attaches
pointer and keyboard input, and redraws only after something changes. Without one, it renders only
[images](#images) and [video](video.md).

```ts
network.set({ at: 12 }); // model coordinate shown, such as a time
network.set({ paused: true }); // stop drawing; state is kept
network.set({ input: 'inspect' }); // 'navigate', 'inspect', 'none'; diagrams add 'edit'
network.on('frame', () => showStats(network.stats())); // after each drawn frame
```

## Update

`set` applies a patch to the config:

- Keyed records (`vertices`, `edges`, `paths`, `traces`, `groups`) merge per entry, then per option.
- `camera`, `input`, `limits`, and `layout` merge per option.
- `null` removes an entry or resets an option. Any other value replaces.

```ts
network.set({
  vertices: { Bus: { size: { field: 'capacity', range: [3, 12] } } },
  paths: { Border: null },
  edgeWidthPx: 2,
});
```

Data updates are explicit: `view.set({ source: nextData })`. Views never subscribe to a model
or request historical data. Share unchanged column pages when constructing the next value.

An invalid patch throws and changes nothing. `view.config` holds the current config.

## Camera

`view.camera` is where the camera is. `set({ camera })` moves it, and `{ animate: true }` eases the
move. `fit: true` keeps the data in view as it changes; any explicit move turns it off.

```ts
network.set({ camera: { projection: 'globe' } }, { animate: true });
network.fit(network.selection, { animate: true });
network.on('camera', (camera) => showZoom(camera.scale));
```

## Select and pick

```ts
const [item] = await network.pick([x, y]);
network.select(item ? [item] : []);
network.on('select', (items) => inspect(items));
network.on('hover', (item) => tooltip(item));
network.on('contextmenu', ({ point, items }) => openMenu(point, items));
```

`select`, `hover`, and `contextmenu` report what the user did. Items keep their source, `Index`, and
row. `locate(item)` returns an item's canvas point, and `reveal(item)` pans until it shows.

## Images

```ts
const png = await network.image({ width: 2048, height: 1024, at: 12 });
```

The image renders offscreen at any size; a canvas keeps presenting afterwards.

## Compose

```ts
import { createComposition } from '@latkit/gpu';

const dashboard = createComposition(gpu, {
  canvas,
  views: [
    { view: network, region: [0, 0, 1, 0.6] },
    { view: monitor, region: [0, 0.6, 1, 0.4] },
  ],
});
```

Regions are `[x, y, width, height]` fractions from the top left. A composition borrows views that have
no canvas of their own.

## Clean up

```ts
network.destroy();
gpu.destroy();
```

`destroy` releases the view's canvas, input, and GPU resources, never its sources or GPU. Destroy the
GPU after its views.

Failures inside a frame emit `error`, or reach the console when nothing listens. Limits fail with
`resource-limit`. After device loss, views emit a `device-lost` error; recreate the GPU and its views.
