# Application-owned data

A `Data` value holds a schema, row identities, and column pages. It never changes: a change is a
new value, so every read and view of one value sees the same observations. Keeping a reference
keeps the values; dropping it lets garbage collection release them. Values stay valid after the
connection that delivered them closes. Which values to keep, persist, or share is the
application's choice.

## Build values

`createData(schema, batches)` builds a complete value from row and sample batches. Each cell may be
supplied once: a duplicate value or row identity rejects rather than overwrites. To change static
data or topology, build a new value, passing unchanged column buffers again to share them.

`appendData(previous, batches)` adds sampled observations and shares the earlier pages and
buffers. It rejects row batches. A field's new frames must follow its existing ones, and
coordinates must not move backwards; frame-number gaps and duplicate coordinates are allowed. A
batch may arrive as row and column tiles within one append.

Each batch names the `index` of its rows. `{ source, type, version }` identifies one numbering of a
type's rows, which many values can share. A reference column carries its target type's index, and
mismatched indices reject rather than join unrelated rows.

Both helpers check row spaces, cells, and append boundaries, but not column layouts. Check
untrusted batches with `validateBatch` first; `@latkit/connect` validates what it receives. Never
mutate the arrays, schema, or pages of a value.

## Read values

```ts
import { read } from '@latkit/model';

for await (const block of read(data, {
  kind: 'samples',
  from: 'Bus',
  select: ['voltage'],
  window: { kind: 'range', between: [0, 10] },
})) {
  console.log(block.coordinates);
}
```

Reads are local and yield bounded blocks. They never ask a model for missing values: a `frames`
window outside the supplied observations rejects.

A `Reader` memoizes reads in a memory pool and joins fields of several sources to one row order. A
scope holds what it read until it closes. Results are keyed by the values they read, so appending
samples or replacing one field leaves other reads cached. Every view on a GPU reads through that
GPU's reader.

```ts
import { createMemory, createReader } from '@latkit/model';

const reader = createReader({ memory: createMemory({ cpuBytes: 64 * 1024 ** 2 }) });
const reads = reader.open({ signal, at: playhead });
try {
  for await (const block of reads.fields({ source: data, from: 'Bus', fields: { load: 'load' } }))
    draw(block.rows, block.columns.load);
  console.log(await reads.extent({ source: data, from: 'Bus', field: 'load' }));
} finally {
  reads.close();
}
```

## Show values

Pass a value to a view as `source`, and each change with `view.set({ source: nextData })`; see
[views](views.md#update). Share unchanged pages: views keep the reads and GPU uploads made from
them, and a monitor extends its image when the new value only appends.
