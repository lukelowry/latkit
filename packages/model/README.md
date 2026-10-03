# @latkit/model

Immutable columnar values, bounded local reads, and portable command descriptions for Latkit.

| Contract                               | Responsibility                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `Data`                                 | Immutable application-owned schema, row identities, and indexed column pages |
| `DataBatch`                            | Plain static rows or sampled observations                                    |
| `read(data, query, options)`           | Bounded local rows, samples, aggregates, and envelopes                       |
| `createReader(options)`                | Memoized reads, joined fields, and extents under one memory budget           |
| `selectBatches(data, fields, options)` | Selected plain batches from a captured value                                 |
| `CommandDescription` / `Parameter`     | Shared command vocabulary without connection or transport state              |

## Supply values

```ts
import { createData, read } from '@latkit/model';

const schema = {
  types: { Bus: { fields: { load: { type: 'float64' } } } },
} as const;
const source = createData(schema, [
  {
    kind: 'rows',
    index: { source: 'grid', type: 'Bus', version: 'rows-1' },
    rows: { kind: 'range', offset: 0, count: 3 },
    columns: { load: { kind: 'numeric', offset: 0, length: 3, values: Float64Array.of(2, 4, 6) } },
  },
]);

// Pass source directly to any Latkit view.
for await (const block of read(source, { kind: 'rows', from: 'Bus', select: ['load'] }))
  console.log(block.columns.load);
```

`Data` has no methods, model reference, or close operation. Keeping a reference keeps the
values. Dropping references lets normal garbage collection release them. Never mutate
published arrays, schema, pages, or indices. A new value represents a change.

`createData(schema, batches)` constructs a complete value from `RowBatch` and
`SampleBatch` inputs. Batches describe disjoint cells: duplicate static values or row identities
reject instead of overwriting. To change static data or topology, construct a fresh value;
unchanged immutable column buffers can be supplied again without copying their payloads.

`appendData(previous, sampleBatches)` accepts only new sampled observations. It shares
existing pages and buffers, and rejects row batches, corrections, and backfilling into a field's
committed frame range. Row and column tiles of one append are validated together, so a batch can
arrive in pieces. Frame-number gaps and duplicate coordinates remain supported; coordinates must
not move backwards. Neither helper accepts `replace` or mutates earlier `Data` values.

These are pure application storage helpers. They do not fetch, subscribe, retain a model, or keep
global history. Your application decides which values to hold, persist, or discard.

## Locate an observation

Field pages are immutable indexed collections (`ColumnPages`), built by `createData` and
`appendData`. Appending shares the earlier page and sample indexes; it does not copy the entire
page list or rebuild the earlier sample index. Older `Data` values remain valid.

```ts
const pages = data.tables.Node.fields.output;
const first = pages.at(0); // replaces pages[0]
for (const page of pages) consume(page);
```

Use `appendedPages(previousPages, nextPages)` to inspect just an appended suffix; it returns
`undefined` for a replacement. `samplePages(pages, window)` visits only pages covering a sample
window. Neither function retains a model or performs I/O. Construct data from batches rather
than assigning arrays directly to `TableData.fields`. `copyBuffers(data)` preserves these indexes
while copying payloads; `Data` itself is not a structured-clone transport format. Transport uses
plain `DataBatch` values.

`resolveRows(data, { from, select, rows, at })` resolves physical row identity and ordering without
gathering field values. It uses the same sampled coverage rules as `read`, including independent
field clocks, missing observations, and ID selections. These helpers are optional; views use them
automatically.

`locateSample(pages, at)` resolves the last observation at or before a finite coordinate without
reading or copying its values. It returns `{ frame, coordinate, offset, pages }`, or `undefined`
before the first observation or when no samples exist. Duplicate coordinates select the last
observation, matching `read()`; frame-number gaps and row tiles are supported.

```ts
import { locateSample } from '@latkit/model';

const sample = locateSample(data.tables.Bus.fields.voltage, playhead);
if (sample) console.log(sample.frame, sample.coordinate);
```

Views perform this lookup automatically. Applications do not need to quantize their playheads
or add their own sample caches.

## Read through a reader

A `Reader` memoizes reads over immutable values within one memory budget. A scope holds what it
read until it closes; every view on a GPU shares that GPU's reader.

```ts
import { createReader } from '@latkit/model';

const reader = createReader({ maxBytes: 64 * 1024 ** 2 });
const reads = reader.open({ signal, at: playhead });
try {
  for await (const block of reads.fields({ source, from: 'Bus', fields: { load: 'load' } }))
    draw(block.rows, block.columns.load);
  console.log(await reads.extent({ source, from: 'Bus', field: 'load' }));
} finally {
  reads.close();
}
```

`fields` joins fields of other sources and local `FieldValues` to one physical row order in
bounded blocks; `presence` marks the rows a partial binding covers. Results are keyed by the
values they read, so appending samples or replacing one field leaves other reads cached.

## Select values on demand

`selectBatches` reads a captured immutable value and yields only selected fields and their row
identities. Static columns, sampled fields with independent clocks, gaps, and native strides are
preserved. Indexed coordinate reads avoid repeatedly scanning the complete sample history.

```ts
import { selectBatches } from '@latkit/model';

for await (const batch of selectBatches(data, [{ from: 'Bus', select: ['voltage'] }], {
  signal,
  maxBlockBytes: 256 * 1024,
})) {
  await publish(batch);
}
```

It performs local work only. A model can return this iterable from its `monitor`, or use it with
a command's requested outputs. Live subscriptions, publication ownership, backpressure, and
cancellation belong to `@latkit/connect`. This package has no polling service, begin/end event
union, or transaction assembler.

`staticFields(schema)` selects every field that is not sampled, of every type: what a model holds
outside its runs. `sampledFields(schema, types?)` selects every sampled field of `types`, all types
by default: what a run can record.

## A model

`Model` is the contract a model meets: a `name`, a `schema`, an optional `monitor(fields, context)`
returning batches, and `commands`, each a `CommandDescription` with `run(values, context)`. A
command's `CommandContext` carries its requested `outputs` and `publish`, `progress`, and `log`.
The same context reaches a handler whether it is called in process or across `@latkit/connect`,
where whoever runs a command supplies it, so a model accepted over a connection is itself a
`Model`. `Publication` names batches published together.

`CommandDescription` holds parameters and labels; `Arguments<typeof parameters>` infers
handler arguments, including optional/defaulted values, choices, and multiple values. Parameters
support numbers, booleans, text, choices, domain-ID references, and bounded File inputs.
`Progress`, `Diagnostic`, and `CommandResult` are the shared status/result vocabulary.
`failure(code, message, { target, issues })` builds the shared `Failure` a command throws to
report a code that crosses the connection, such as `busy` or `invalid-input`.
These are descriptions and values, without opcodes or transport implementation.

## Identity, layout, and validation

A `Data` value never changes; a new value is a new object, so identity is its version.
`Index = { source, type, version }` identifies a physical row numbering, which can stay unchanged
across many values. References carry
the target type's index; incompatible indices fail rather than joining unrelated rows.
String IDs are optional pages used for domain-ID selection. Sample pages carry absolute
frame numbers and Float64 coordinates, independently of their numeric field precision.

Schema declares column types, nullability, spatial meaning, and the sample axis. It does
not declare transport limits or query capabilities. Use `validateSchema`, `validateSelection`,
`validateBatch`, and `validateBlock` at trust boundaries. Batch/block validation applies a
byte limit when explicitly supplied; local `read` and `selectBatches` default to
`DEFAULT_BLOCK_BYTES` (256 KiB). Override through `QueryOptions.maxBlockBytes`.
Storage helpers expect validated column layouts; they additionally check row-space compatibility,
disjoint cells, and append boundaries without rescanning stored payloads.

Queries yield byte-bounded blocks. Contiguous reads share
immutable typed-array views. Sparse selections and batched small sample pages may copy.
Use `buffers: 'owned'` for independent allocations you may mutate or transfer; never detach
application-owned buffers. Local filtering and reductions require the relevant fields to
have been supplied. They never ask a model for missing values.

## Breaking migration

Remove `Model`, `Commands`, `Routine`, `MonitorOptions`, `DataEvent`,
`validateDataEvent`, and `transactions` imports. Use `connectModel` / `acceptModel`
from connect for remote behavior, `CommandDescription` / `Parameters` for command metadata,
and `validateBatch` for plain batches. Replace schema `limits` with per-operation query or
connection limits. There is no compatibility layer.

Applications construct or append their own immutable `Data` values from received batches.
Views still take `source: data` and updates through `view.set({ source: nextData })`.
Data remains usable after unsubscribe, connection closure, or view destruction.

[API](https://latkit.readthedocs.io/en/latest/api/reference/model/index.html)
