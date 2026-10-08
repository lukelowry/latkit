# Views

A network, monitor, diagram, or composition is a view. Create it from a GPU and a config, change it
with `set`, and destroy it when done. Network, monitor, and diagram are item views: they also share
a camera, selection, picking, hover, and style, the `ItemView` contract in `@latkit/gpu`.

```ts
import { createGpu } from '@latkit/gpu';
import { createNetwork } from '@latkit/network';

const gpu = await createGpu();
const network = createNetwork(gpu, { canvas, source, vertices: { Bus: {} } });
```

## Present

With a `canvas`, a view sizes it to its CSS size and pixel ratio, handles its input, and redraws
only after something changes. Without one, it renders only [images](#images) and [video](video.md).

```ts
network.set({ at: 12 }); // model coordinate shown, such as a time
network.set({ paused: true }); // stop drawing; state is kept
network.set({ input: 'inspect' }); // 'navigate', 'inspect', or 'none'; a diagram also has 'edit'
network.on('frame', () => showStats(network.stats())); // after each drawn frame
```

Every item view handles the same input:

- A click selects what it hits. Clicking again in place cycles through overlapping hits while they
  stay the same. Shift, Ctrl, or ⌘ toggles the topmost hit.
- A double click or Enter reports `open`. A double click on nothing fits the data while navigating.
- A right click opens a menu where the button comes up, unless it dragged. A held touch opens one
  too, and the menu key or Shift+F10 opens one at the selection.
- Escape ends a gesture or clears the selection.
- While navigating, Home fits the data. A network or diagram also pans on a drag and zooms on the
  wheel, a pinch, or + and −. `input: { wheel: 'modifier' }` zooms only with Ctrl or ⌘.

A click, double click, or menu answers with what the presented frame draws there. A later gesture
supersedes one still finding its hits. Each view adds its own gestures, such as dragging a block.

## Update

`set` applies a patch to the config:

- Keyed records (`vertices`, `edges`, `paths`, `traces`, `groups`) merge per entry, then per option.
- `camera`, `input`, `limits`, and `layout` merge per option.
- `null` removes an entry or resets an option to its default.
- Any other value replaces. Plain objects and arrays compare by what they hold, and a patch that
  changes nothing does nothing.
- A channel such as `color` or `widthPx` takes one value, a field, or a scale; see
  [data bindings](topology-and-channels.md#channels).

```ts
network.set({
  vertices: { Bus: { radiusPx: { field: 'capacity', range: [3, 12] } } },
  paths: { Border: null },
  edgeWidthPx: 2,
});
```

`{ animate: true }` eases the change over `animationMs`. `{ replace: true }` takes the patch as the
whole config: what it leaves out resets, except the canvas, `at`, `paused`, and camera. An
application can pass its whole config on every change; the view rebuilds only what differs. An
invalid patch throws `invalid-input` and changes nothing.

To show new data, pass a new [`Data`](document-sessions.md) value: `set({ source: next })`.

## Layout

A network or diagram places each vertex its data gives no position: every row of a type without `x`
and `y`, and each row whose `x` or `y` reads no number. Vertices that edges join form a part, and
`layout.algorithm` arranges each part alone: `'stress'` by default in a network, `'layered'` in a
diagram, or a `LayoutStrategy` of your own. Parts with nothing positioned pack into rows below the
rest. Placed vertices keep their place as the data changes; new `layout` options place them anew.

`arrange(gpu, config)` in `@latkit/network` and `@latkit/diagram` places the vertices without
drawing. It returns `Positions` by type: an `x` and a `y` field to spread into the type's options.

## Style

Every item view takes the same style options, with defaults in `viewStyle`:

| Option                            | Default                  | Per view                              |
| --------------------------------- | ------------------------ | ------------------------------------- |
| `background`                      | dark blue-gray           |                                       |
| `msaa`                            | `4`                      | monitor and diagram `1`               |
| `hover`, `hoverBudgetMs`          | `'auto'`, `2`            |                                       |
| `pickRadiusPx`                    | `8`                      |                                       |
| `fitPaddingPx`, `revealPaddingPx` | `32`, `48`               |                                       |
| `animationMs`, `motion`           | `300`, `'auto'`          | monitor `0`                           |
| `hoverColor`                      | amber                    | network alpha `0.65`                  |
| `selectedColor`                   | orange                   | network alpha `0.9`; monitor `'none'` |
| `hoverWidthPx`, `selectedWidthPx` | `6`, `8`                 | monitor draws no hover glow           |
| `unselectedAlpha`                 | `1`                      | monitor `0.25`                        |
| `font`, `fontSizePx`, `textColor` | `system-ui`, `12`, light | monitor monospace                     |

Hover and selection draw a glow. `hoverColor` and `selectedColor` color it, and their alpha sets
its strength. `hoverWidthPx` and `selectedWidthPx` set how far it reaches. `selectedColor: 'none'`
glows in each item's own color. While something is selected, `unselectedAlpha` fades everything
else.

`shade` recolors every fragment with WGSL of your own, `spotlight()` around the pointer, or
`pulse()` on rows whose `shade` channel is positive.

## Camera

`view.camera` is where the camera is going, and `set({ camera })` moves it. While `fit` is true, the
view keeps the data in view; moving a framed part of the camera by hand turns it off.
`set({ camera: null })` and `fit()` follow all the data again.

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

`pick` finds what the presented frame draws near a point. `select` replaces the selection without
reporting it; the `select` event reports what the user chose, and selected items a new source
drops. `hover` also reports the same item found with other detail, such as a monitor reading
another sample. `frame`, `camera`, and `hover` arrive in that order after a drawn frame.

An item is a row: `{ source, index, row }`. Its `Index` names the row space, so an item outlives
appends that replace its `Data`, but not a new index version. `sameItem` and `itemKey` in
`@latkit/model` compare items.

## Images

```ts
const png = await network.image({ width: 2048, height: 1024, at: 12 });
```

A view on a canvas or in a composition keeps what it presents. A view with neither presents in its
images, so `pick` and `locate` follow the latest one.

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

Regions are `[x, y, width, height]` fractions from the top left. A composition borrows views
without a canvas of their own. Input reaches the view under the pointer, which hovers, picks, and
navigates as it would on its own canvas.

## Clean up

```ts
network.destroy();
gpu.destroy();
```

`destroy` never closes a view's source or GPU. Destroy the GPU after its views.

A failure inside a frame emits `error`, or reaches the console when nothing listens. Exceeded limits
fail with `resource-limit`. When the device is lost, `gpu.signal` aborts with `device-lost`, and
each view emits it once and stops drawing; recreate the GPU and its views.
