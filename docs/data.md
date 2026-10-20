# Data

A dataset is a name and its tables. A table is rows, each with an id, and fields, a value per row.
Patches change datasets all at once: every change of a patch, or none.

## Write a dataset

```ts
import { Patch, reference } from 'latkit';

const { Data } = await loadLatkit();
const grid = new Data('grid').apply(
  new Patch()
    .replace('Bus', [101, 102, 103], {
      lon: Float64Array.of(-97.7, -97.6, -97.5),
      lat: Float64Array.of(30.2, 30.3, 30.4),
      name: ['North', 'Mid', null],
    })
    .replace(
      'Branch',
      { count: 2 },
      {
        from: reference('Bus', [101, 102]),
        to: reference('Bus', [102, 103]),
      },
    ),
);
```

- **Ids** are numbers or texts, listed, or `{ count: n }` for rows `0` to `n - 1`.
- **Values** are a column per field: typed arrays of numbers (a `Uint8Array` holds booleans), or
  arrays of numbers, booleans, texts, or geometries. `null` is missing.
- **Geometries** are `[x, y]` points, paths of points, parts (a polygon's rings, or a path's
  pieces), or polygons.
- **References** name rows of another table by id: `reference(table, ids)`.

| Change                                  | Does                                                                 |
| --------------------------------------- | -------------------------------------------------------------------- |
| `replace(table, ids, fields)`           | replaces the table, or adds it                                       |
| `set(table, ids, fields)`               | writes fields for those rows: known ids change, others are added     |
| `remove(table, ids)`                    | removes the rows                                                     |
| `axis(name, unit)`                      | names the axis sampled fields are recorded over                      |
| `append(at, table, fields, ids?)`       | records a frame at each coordinate of `at`, of every row or of `ids` |
| `forget(before)`                        | forgets the frames before a coordinate                               |
| `frames(table, field, run, at, values)` | holds a run of a sampled field's entries, as a time tile does        |

## Change it

`apply` changes a dataset in place. A snapshot keeps a version in O(1), sharing its pages, so an
undo history costs only what changed. A view draws the version it was given until it is given
another:

```ts
const before = grid.snapshot();
grid.apply(new Patch().set('Bus', [101], { name: ['Northgate'] }));
view.setData(grid); // the view draws the change
view.setData(before); // and the version before it
```

## Record over time

A field's first frame makes it sampled. A view shows the axis coordinate `view.at`: each sampled
field reads its last frame at or before it.

```ts
grid.apply(new Patch().axis('time', 's'));
grid.apply(new Patch().append(0.5, 'Bus', { vm: Float32Array.of(1.01, 0.99, 1.0) }));
grid.apply(new Patch().append([1, 1.5], 'Bus', { vm: Float32Array.of(1, 1, 1, 0.98, 0.97, 0.99) }));
grid.apply(new Patch().append(2, 'Bus', { vm: [1.02] }, [101])); // one row; the rest hold
grid.apply(new Patch().forget(1)); // a rolling window
view.at = 1.2;
```

Each sampled field keeps levels of detail as it records: at level `k`, each row's least and
greatest value over buckets of `8^k` frames. A line tracing a field across a plot reads the level
that gives each pixel column a bucket or two, so a long history draws as fast as a short one.

## Fetch long histories in spans

A history too large to load whole is written as time tiles, and a view fetches only what it draws:

```sh
latkit tile history.bin -o history/
```

```ts
view.setTiles('grid', 'history/frames.json');
```

`tile` writes `frames.json`, `base.latk` (the dataset with every sampled field's frames left out),
and each field's history in spans of `--chunk` entries, at every level of detail (`Data::to_tiles`
in Rust). A line tracing a field fetches the spans its plot window draws, at the detail it draws
them, and a mark showing a field fetches the frames about `view.at`. A span still loading draws the
coarser span above it, as a map tile still loading draws the tile a zoom out.

## Stream

Patches are bytes: `patch.toBytes()` writes one frame, and frames back to back stream. Each frame
says its length up front, so a stream never holds more than `limit` bytes (256 MiB unless given). A
server in any language writes the same frames ([format](formats.md#bytes)).

```ts
for await (const patch of Patch.stream((await fetch('/feed')).body!)) {
  grid.apply(patch);
  view.setData(grid);
}
```

A patch made with `Patch.to('grid')` names its dataset, and `apply` refuses it for another.

## Load files

```ts
const grid = await Data.load(json, 'data/grid.json'); // a JSON document, slices relative to it
const saved = await Data.read(bytes); // latkit's bytes, as data.toBytes() wrote them
const states = await Data.read(geojson, 'states'); // GeoJSON, gzip-compressed or not, in a worker
```

GeoJSON becomes tables `points`, `lines`, and `polygons`, each with its geometry as field
`geometry` and its properties as fields. The JSON document's form is in [Formats](formats.md#json).

## Read back

Reading needs no GPU. Queries run the expressions marks draw with:

```ts
grid.get('Bus', 101, 'name'); // 'North'
const hot = grid.query({
  of: 'Branch',
  filter: field('loading').gt(90),
  sort: [['loading', 'descending']],
  select: { name: 'name', loading: 'loading' },
  limit: 20,
});
// { table, ids, fields: { name: string[], loading: Float64Array }, total }
```

`total` counts the rows kept before `limit`. `field('name').contains('north')` matches texts in
queries. `describe()` lists tables, rows, fields and their kinds, and the axis and its span.
`envelope(table, field, range, spans)` gives each row's least and greatest value of a sampled field
over equal spans of the axis, read from levels of detail, so a span costs a few reads however many
frames it covers.
