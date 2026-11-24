# Datasets and queries

## Write a dataset

This example has three buses and two branches. Each branch references its terminal buses by ID. `kv` is nominal voltage in kV. `vm` is voltage magnitude in per unit on that base.

```{literalinclude} ../npm/test/consumer/three-bus.ts
:language: typescript
:start-at: export function threeBusGrid
:end-before: export function voltageDiagram
```

IDs can be strings or nonnegative safe integers. Use `{ count: n }` for IDs from 0 to `n - 1`. Supply one value per row in each column. Use `null` for a missing value.

## Read files

```ts
const grid = await Data.read('data/grid.json'); // a JSON document, its slices relative to it
const saved = await Data.read(bytes); // latkit's bytes, as data.toBytes() wrote them
const states = await Data.read(geojson, { name: 'states' }); // GeoJSON, gzip-compressed or not
```

GeoJSON becomes the tables `points`, `lines`, and `polygons`. [Formats](formats.md#json) describes the JSON
document. `Patch.read` reads one patch from the same kinds of source.

(read-back)=

## Query rows

Here `mva` is apparent power at the branch's **from** end and `rating` is its continuous rating in MVA. North–Mill carries 95 MVA on a 100 MVA rating. Mill–South carries 56 MVA on an 80 MVA rating.

```ts
import { field } from 'latkit';

const grid = threeBusGrid();
grid.describe(); // tables, field names and types
grid.get('Bus', 101, 'name'); // 'North'

const loading = field('mva').div(field('rating')).mul(100);
const result = grid.query({
  of: 'Branch',
  filter: loading.gt(90),
  select: { name: '$name', percent: loading },
});
// result.ids contains branch 1 (North–Mill), at 95% of its rating.
```

(change-it)=

## Update rows

`set` updates or adds rows, `replace` rewrites a table, and `remove` deletes rows. Views redraw after an edit. Take a snapshot to restore an earlier version.

```ts
const before = grid.snapshot();
grid.set('Branch', [1], { mva: [88] });
grid.restore(before);
```

Group edits in a [Patch](reference/api.md#patch) to apply them together.

(record-over-time)=
(fetch-long-histories-in-spans)=
(stream)=

## Time series and streaming

[Append sampled fields](time-series.md#record-over-time), [fetch time tiles](time-series.md#fetch-long-histories-in-spans), or [read a patch stream](time-series.md#stream).
