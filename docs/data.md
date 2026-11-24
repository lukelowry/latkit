# Work with data

A dataset contains named tables. Each row has an ID. Each field holds one value per row.

## Write a dataset

```ts
import { Data, load, reference } from 'latkit';

await load();
const grid = new Data('grid')
  .set('Bus', [101, 102, 103], {
    lon: Float64Array.of(-97.7, -97.6, -97.5),
    lat: Float64Array.of(30.2, 30.3, 30.4),
    name: ['North', 'Mid', null],
  })
  .set(
    'Branch',
    { count: 2 },
    {
      from: reference('Bus', [101, 102]),
      to: reference('Bus', [102, 103]),
      name: ['North-Mid', 'Mid-South'],
      loading: [95, 70],
    },
  );
```

- Ids are nonnegative safe integers or strings, or `{ count: n }` for rows `0` to `n - 1`.
- Values are one column per field: typed arrays, or arrays of numbers, booleans, strings, or
  geometries, with `null` for missing. A `Uint8Array` holds booleans. A field's first
  value sets its kind. Until then, a field of only `null` fits any kind, and reads as missing.
- Geometries are `[x, y]` points, paths of points, parts (a polygon's rings), or polygons.
- References name rows of another table by id: `reference(table, ids)`.

## Change it

Use `set` to update or add rows, `replace` to rewrite a table, and `remove` to delete rows.
Views show the change on the next frame. Group edits in a [`Patch`](reference/api.md#patch)
when they must succeed or fail together. A snapshot takes O(1) time and shares unchanged pages.

```ts
const before = grid.snapshot();
grid.set('Bus', [101], { name: ['Northgate'] }); // drawn the next frame
grid.restore(before); // and undone
grid.apply(new Patch().set('Bus', [101], { name: ['Northgate'] }).remove('Branch', [1])); // together
```

## Record over time

The first append declares a sampled field. Append zero frames if a view needs to open before
the recording arrives. Marks interpolate at `view.at` by default. Use `field(name).step()` to
hold the last sample until the next one. Axis coordinates use `f64` and sampled values use `f32`.

```ts
grid.axis('time', 's');
grid.append('Bus', [], { vm: new Float32Array(0) }); // declared, no frames yet
grid.append('Bus', 0.5, { vm: Float32Array.of(1.01, 0.99, 1.0) });
grid.append('Bus', [1, 1.5], { vm: Float32Array.of(1, 1, 1, 0.98, 0.97, 0.99) });
grid.append('Bus', 2, { vm: [1.02] }, { ids: [101] }); // one row; the rest hold
grid.forget(1); // a rolling window
view.at = 1.2;
```

To play the axis, give views a `Playhead`. Views that follow one show the same coordinate in the
same frame, and scrubbing any of them moves it:

```ts
const playhead = new Playhead({ span: [0, 10] });
map.playhead = monitor.playhead = playhead;
playhead.play(); // one axis unit per second
```

When a plot has more samples than pixels, each pixel column shows the minimum and maximum
for its interval. The recording stores these extrema in buckets of `8^k` frames at level `k`.

## Fetch long histories in spans

Write a history too large to load at once as time tiles. A view then fetches only what it draws:

```sh
latkit tile history.latk -o history/
```

```ts
view.sources = [new Tiles('grid', 'history/frames.json')]; // in place of the dataset named grid
```

A plot fetches tiles for its visible interval and resolution. Other marks fetch the frames
around `view.at`. While a tile loads, the view draws the coarser tile that covers it.

For live recordings, apply append patches to a `TileWriter`, call `flush()`, then call
`tiles.refresh()`. Views reload the last span at each level. Flush once after declaring the
fields if clients need the manifest before the first frame arrives. In Rust, use
`Snapshot::to_tiles` to write a complete dataset. Supply `{ fetch }` to the `Tiles`
constructor to read tiles from a custom server.

## Stream

`patch.toBytes()` encodes a patch as one frame. Frames written back to back form a stream, which a
server in any language can write ([format](formats.md#bytes)). `Patch.stream` yields each patch as soon as
its last byte arrives:

```ts
for await (const patch of Patch.stream((await fetch('/feed')).body!)) grid.apply(patch);
```

`new Patch('grid')` names its dataset, and applying it to another dataset fails.

## Read files

```ts
const grid = await Data.read('data/grid.json'); // a JSON document, its slices relative to it
const saved = await Data.read(bytes); // latkit's bytes, as data.toBytes() wrote them
const states = await Data.read(geojson, { name: 'states' }); // GeoJSON, gzip-compressed or not
```

GeoJSON becomes the tables `points`, `lines`, and `polygons`. [Formats](formats.md#json) describes the JSON
document. `Patch.read` reads one patch from the same kinds of source.

## Read back

Reading needs no GPU, and queries use the same expressions as marks:

```ts
grid.get('Bus', 101, 'name'); // 'Northgate'
const hot = grid.query({
  of: 'Branch',
  filter: field('loading').gt(90),
  sort: [['$loading', 'descending']],
  select: { name: '$name', loading: '$loading' },
  limit: 20,
});
// { table, ids, fields: { name: string[], loading: Float64Array }, total }
```

[`Dataset`](reference/api.md#dataset) lists every read, including `describe()` and `envelope()`. A
`Snapshot` has the same reads, for its own version.
