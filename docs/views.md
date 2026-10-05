# Views

A network, monitor, diagram, or composition is a view: one object, created from a GPU and a config,
updated with `set`, and destroyed when done. Network, monitor, and diagram are item views: they also
share one camera, selection, picking, hover, and style contract, `ItemView` in `@latkit/gpu`.

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
network.set({ input: 'inspect' }); // 'navigate', 'inspect', or 'none'; a diagram also has 'edit'
network.on('frame', () => showStats(network.stats())); // after each drawn frame
```

Every item view handles the same input: hover follows the pointer; a click selects what it hits,
and clicking again in place cycles through overlapping hits; Shift, Ctrl, or ⌘ toggles the topmost
hit; a double click or Enter reports `open`, and a double click on nothing fits the data while
navigating; a right click opens a menu where the button comes up (a right drag never does); the
context menu key or Shift+F10 opens a menu at the selection; Escape ends a gesture or clears the
selection; and, when navigating, the wheel zooms (or only with Ctrl or ⌘ under
`input: { wheel: 'modifier' }`), Home fits the data, and + and − zoom. Each view adds its own
gestures, such as dragging.

## Update

`set` applies a patch to the config:

- Keyed records (`vertices`, `edges`, `paths`, `traces`, `groups`) merge per entry, then per option.
- `camera`, `input`, `limits`, and `layout` merge per option.
- `null` removes an entry or resets an option. Any other value replaces, unless it equals what is
  there: plain objects and arrays compare by what they hold, data by identity, and a patch that
  changes nothing does nothing, `animate` included.
- `{ replace: true }` takes the patch as the whole config: what it leaves out resets, except the
  canvas, `at`, `paused`, and camera. An application that builds its config from its state can
  pass all of it on every change, and the view rebuilds only what differs.
- A channel such as `color`, `x`, or `widthPx` takes one value, a field name, or a scale; see
  [data bindings](topology-and-channels.md#channels).

```ts
network.set({
  vertices: { Bus: { radiusPx: { field: 'capacity', range: [3, 12] } } },
  paths: { Border: null },
  edgeWidthPx: 2,
});
```

Data updates are explicit: `view.set({ source: nextData })`. Views never subscribe to a model
or request historical data. Share unchanged column pages when constructing the next value.

An invalid patch throws `invalid-input` and changes nothing: an unknown option, limit, camera
option, or input option, or an input mode the view does not have. `view.config` holds the current
config; the camera lives on `view.camera`.

## Style

Every item view takes the same style options, with one set of defaults in `viewStyle`:

| Option                            | Default                  |                                                                                   |
| --------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `background`                      | dark blue-gray           |                                                                                   |
| `msaa`                            | `4`                      | monitor `1`: its history images would cost 4×; diagram `1`: its shaders antialias |
| `hover`, `hoverBudgetMs`          | `'auto'`, `2`            | `auto` searches within the budget once motion stops                               |
| `pickRadiusPx`                    | `8`                      |                                                                                   |
| `fitPaddingPx`, `revealPaddingPx` | `32`, `48`               |                                                                                   |
| `animationMs`, `motion`           | `300`, `'auto'`          | monitor `0`; `auto` follows reduced motion                                        |
| `hoverColor`, `selectedColor`     | amber, orange            | monitor `'none'`, keeping trace colors; it draws no hover                         |
| `hoverWidthPx`, `selectedWidthPx` | `3`, `3`                 |                                                                                   |
| `font`, `fontSizePx`, `textColor` | `system-ui`, `12`, light | monitor uses a monospace font                                                     |

Each view adds its own options, such as a network's `edgeWidthPx` or a monitor's `yAxis`. Padding
takes one number or `[top, right, bottom, left]`. `null` in a config or a patch always means unset,
which restores the default.

## Camera

`view.camera` is where the camera is going. `set({ camera })` moves it, and `{ animate: true }`
eases the move. While `fit` is true the view keeps the data in view as it changes; moving a framed
part of the camera by hand turns it off. `set({ camera: null })` and `fit()` follow all the data
again; `fit(items)` frames those items once.

```ts
network.set({ camera: { projection: 'globe' } }, { animate: true });
network.fit(network.selection, { animate: true });
network.on('camera', (camera) => showZoom(camera.scale));
```

## Select and pick

```ts
const [item] = await network.pick([x, y], { radiusPx: 12, limit: 4 });
network.select(item ? [item] : []);
network.on('select', (items) => inspect(items));
network.on('hover', (item) => tooltip(item));
network.on('contextmenu', ({ point, items }) => openMenu(point, items));
```

`pick` returns hits nearest first, the item drawn on top winning ties, at most `limit` (16 by
default). `select` replaces the selection without reporting it; `select`, `hover`, and `contextmenu`
events report what the user did, and `select` also reports items a new source no longer has. Items
keep their source, `Index`, and row. `locate(item)` returns an item's canvas point, and
`reveal(item)` pans until it shows.

Events arrive together after each drawn frame, in order: `frame`, `camera`, `hover`, `select`.

## Images

```ts
const png = await network.image({ width: 2048, height: 1024, at: 12 });
```

An image renders at any size and coordinate, as a `png`, `jpeg`, or `webp` `format`, with `quality`
from 0 to 1 for the last two. A view on a canvas or in a composition stays as it is:
its camera, hover, selection, and what `pick` finds stay as presented. A view with neither presents
in its images, so `pick` and `locate` follow the latest one. [Video](video.md) always draws the view
as it is and changes nothing.

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
no canvas of their own. Pointer, wheel, menu, and key input reach the view under the pointer, in its
own canvas points, so each view hovers, picks, and navigates as it would on a canvas of its own.

## Clean up

```ts
network.destroy();
gpu.destroy();
```

`destroy` releases the view's canvas, input, and GPU resources, never its sources or GPU. Destroy the
GPU after its views.

Failures inside a frame emit `error`, or reach the console when nothing listens. Limits fail with
`resource-limit`. When the device is lost, `gpu.signal` aborts with a `device-lost` error, and each
view emits it once and stops drawing; recreate the GPU and its views. Destroying the GPU stops its
views without an error.
