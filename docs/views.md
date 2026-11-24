# Views and interaction

`View.create(canvas, scene)` draws a scene on a `<canvas>` and fits everything in view once it
draws. Several views can share a canvas. Each takes a region, `[x, y, width, height]` in fractions
of the canvas, and pointer, wheel, and key input goes to the view under the pointer:

```ts
const map = await View.create(canvas, mapScene, { region: [0, 0, 1, 0.7] });
const plot = await View.create(canvas, plotScene, { region: [0, 0.7, 1, 0.3] });
```

A view with a `null` canvas draws only into [pictures](pictures-and-video.md). Views draw with the
first `Gpu` created, and `View.create` creates one if there is none. Create a `Gpu` first to set its
[budget](#memory), or create another for views that should not share its memory, and pass it as
`gpu`.

A view follows changes to each `Data`. Assign additional datasets to `view.sources`, or
replace a source by supplying another with the same name. Use a `Snapshot` to show a fixed
version. Use [`Tiles`](reference/api.md#tiles) for time or vector tiles.

`tiles.describe()` returns the attribution and layer descriptions. Supply a custom `fetch`
to control loading and call `refresh()` when the files change. Views that share a `Tiles`
object reuse its cached tiles.

After device loss, latkit requests a new GPU when the page returns to the foreground.
Views retain their state, listeners, and pending captures.

The [WECC240 recording](examples/wecc.md) uses one time coordinate for a map and two plots.

## Camera

```ts
view.fit(); // everything drawn, as a new view does
view.fit({ rows: [{ data: 'grid', table: 'Bus', ids: [101, 102] }] });
const framed = await view.fit({ tables: [grid.table('Bus')] }); // the camera, or null if replaced
view.camera = { pitch: 45 }; // a partial camera keeps the rest
view.fly({ center: [-97.7, 30.3], zoom: 8, pitch: 40, bearing: 0 }); // ease there
view.camera = { x: [0, 60], y: null }; // a plot's camera: the axis range, values fitted
view.insets = [48, 0, 0, 320]; // CSS pixels kept clear: top, right, bottom, left
view.orbit = 6; // degrees a second
view.on('area', ([x, y, width, height]) => place(timeline, x, width)); // where marks draw
```

On a flat map, you can pan to the edge of the world and zoom out until the whole map fits.
A globe zooms out until it fills a third of the view. After a fit, the camera can zoom out
three more levels and pan one fitted width or height. Change these limits with
`controls.reach`. For example, `{ reach: { zoomIn: 8 } }` limits zooming in to eight levels,
and `{ reach: 'space' }` uses only the limits of the space.

A fit waits until rows have positions. Until the first fit completes, the view shows its
background. On earth, a fit zooms in at most to street scale.

## Events

Intent events (`click`, `open`, `menu`, `drag`, `connect`, `delete`) fire once per action, in the
order the user acted. Change events (`hovered`, `selection`, `camera`, `at`, `waiting`,
`failures`) carry the latest state, which the property of the same name also holds. Setting a
property fires no event. An `error` event means the view can't draw.

```ts
view.on('click', ({ hit }) => console.log(hit.row, hit.point));
view.on('drag', ({ patch }) => patch && grid.apply(patch)); // the dragged row's new place
view.on('selection', ({ rows }) => inspect(rows));
view.on('failures', (failures) => show(failures.map((f) => `${f.path}: ${f.message}`)));
view.on('error', (error) => console.error(error.code, error.message));
```

Views share their selection, hover, and time through these events. In every view, the rows one
reference from a selected or hovered row, such as the machines of a selected bus, draw on top. A
selection keeps them bright while the rest dim, and `related()` styles them:

```ts
for (const [from, to] of [
  [map, monitor],
  [monitor, map],
]) {
  from.on('selection', ({ rows }) => (to.selection = rows));
  from.on('hovered', ({ hit }) => (to.hovered = hit?.row ?? null));
  from.on('at', (at) => (to.at = at));
}
```

## Rows

A row is `{ data, table, id }`, and a set of rows in one table `{ data, table, ids }`:

```ts
view.selection = [{ data: 'grid', table: 'Bus', ids: [101, 102] }];
const joined = view.neighbors({ data: 'grid', table: 'Bus', id: 101 }); // across edges and nets
const hits = await view.pick([x, y], { radius: 8 }); // rows within 8 CSS pixels, nearest first
const at = await view.screenOf({ data: 'grid', table: 'Bus', id: 101 }); // [x, y] on screen, or null
```

## Layouts into data

`view.arrange()` repositions vertices that have no position. Pass `'all'` to reposition
every vertex. Apply the returned patches to save the new positions in each dataset:

```ts
for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
```

## Memory

`gpu.budget = { bytes, uploadPerFrame }` caps the GPU memory that data uses and the bytes uploaded
per frame. Set it before data draws, on a `Gpu` created before any view or on `view.gpu`. All views
of one GPU share the budget. A view that needs less than an even split gets all it needs, and the
other views divide the rest. A table too large for its view's share is split into pages, and the
view draws only the pages on screen. A patch re-evaluates only the pages it wrote.

The budget defaults to half the device's addressable word-texture capacity, at most 1 GiB. GPU memory that
latkit replaces, or that a closed view or a finished picture leaves behind, is freed by the next
frame rather than whenever the browser collects it. A device without the memory to grow the data
further is given up, and the views move to a new one with the budget lowered to what it gave.

`budget.tiles` caps the memory for the tiles fetched from every `Tiles` source, 256 MiB unless set.
Past it, the tiles no view draws are dropped, least recently drawn first.

`view.stats`, `gpu.work`, `gpu.resident`, and `gpu.uploading` report what the views draw and what
work the GPU did. To drive frames yourself in a test or benchmark, call `gpu.step(now)` and wait on
`gpu.landed()` between frames.
