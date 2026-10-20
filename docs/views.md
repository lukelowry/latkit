# Views

A `Gpu` makes views and canvases. A view draws one scene from the datasets it is given by name; a
canvas shows views, one per panel, and passes each the input on its panel.

```ts
const gpu = await Gpu.create();
const map = gpu.view(mapScene);
const plot = gpu.view(plotScene);
gpu
  .canvas(element, {
    panels: [
      [0, 0, 1, 0.7],
      [0, 0.7, 1, 0.3],
    ],
  })
  .show([map, plot]);
for (const view of [map, plot]) view.setData(grid);
```

## Data and tiles

`setData(data)` gives a view a dataset, replacing the one of its name; `removeData(name)` takes it
away. `setTiles(name, url)` fetches vector tiles as the camera asks for them (a PMTiles archive, a
TileJSON document, or a `{z}/{x}/{y}` template), kept as dataset `name`: each layer is a table of
the kind marks draw it as, or named `layer:polygons`, `layer:lines`, or `layer:points`.

## Camera

```ts
view.fit(); // everything drawn
view.fit({ rows: [{ data: 'grid', table: 'Bus', ids: [101, 102] }] });
view.fly({ center: [-97.7, 30.3], zoom: 8, pitch: 40, bearing: 0 }); // ease there
view.camera = { x: [0, 60], y: null }; // a plot's camera: the axis range, values fitted
view.insets = [48, 0, 0, 320]; // CSS pixels kept clear: top, right, bottom, left
view.orbit = 6; // degrees a second
```

## Events

`view.on(type, listener)` returns a function that stops listening. Intents are told once each, in
the order the user acted: `click`, `open`, `menu`, `drag`, `connect`, `delete`. Changes tell only
their latest, and their state can always be read: `hover` (`view.hovered`), `select`
(`view.selection`), `camera`, and `waiting` (`view.stats.waiting`). A view tells only what the
application did not do: its setters change state silently.

```ts
view.on('click', ({ hit }) => console.log(hit.row, hit.point));
view.on('select', ({ rows }) => inspect(rows));
view.on('error', (error) => console.error(error.code, error.path, error.message));
```

## Rows

A row is `{ data, table, id }`; a set of rows of one table is `{ data, table, ids }`. The selection,
`select` events, `delete` events, fits, and neighbors are sets:

```ts
view.select([{ data: 'grid', table: 'Bus', ids: [101, 102] }]);
const joined = view.neighbors({ data: 'grid', table: 'Bus', id: 101 }); // across edges and nets
const hits = await view.pick([x, y], 8); // rows within 8 CSS pixels, nearest first
const at = await view.locate({ data: 'grid', table: 'Bus', id: 101 }); // [x, y] on screen, or null
```

Picks and locations answer once a frame draws the view, and reject with `timeout` after a deadline
(`{ deadline: 5 }` seconds unless given) and with `cancelled` when the view is destroyed.

## Layouts into data

In a diagram, or on a plane with a layout, rows without positions are placed by it.
`view.arrange()` lays every row out again and answers a patch to each dataset writing the places
into its position fields:

```ts
for (const patch of await view.arrange()) if (patch.data === grid.name) grid.apply(patch);
view.setData(grid);
```

## Stats and memory

`view.stats` tells rows drawn, draw calls, tiles, bytes resident and uploading, and CPU and GPU
milliseconds a frame. `gpu.work` counts exactly what the GPU did: bytes uploaded and written, rows
evaluated, readbacks, jobs, texts, and pipelines. `gpu.budget = { bytes, uploadPerFrame }` sets how
much memory data takes; a table too large for its share draws through the tiles in view.

Every handle has an idempotent `destroy()` and `Symbol.dispose`; destroying a `Gpu` destroys its
canvases, views, and frame listeners.
