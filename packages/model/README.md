# @latkit/model

Columnar values, passive observation, and local computation for Latkit.

| Contract            | Responsibility                                                       |
| ------------------- | -------------------------------------------------------------------- |
| `Data`              | Immutable application-owned schema, row identities, and column pages |
| `Model`             | Schema and one-pass `monitor(fields)` publications                   |
| `Commands`          | Optional, independent routines and `run(command)`                    |
| `read(data, query)` | Bounded local rows, samples, aggregates, and envelopes               |

## Supply values

```ts
import { createData, read } from '@latkit/model';

const schema = {
  limits: { maxBlockBytes: 256 * 1024 },
  types: { Bus: { fields: { load: { type: 'float64' } } } },
} as const;
const source = createData(schema, 'data-1', [
  {
    kind: 'rows',
    index: { source: 'grid', type: 'Bus', version: 'rows-1' },
    rows: { kind: 'range', offset: 0, count: 3 },
    columns: { load: { kind: 'numeric', offset: 0, length: 3, values: Float64Array.of(2, 4, 6) } },
  },
]);

// Pass source directly to any Latkit view.
for await (const block of read(source, { kind: 'rows', from: 'Bus', select: ['load'] })) {
  if (block.kind === 'rows') console.log(block.columns.load);
}
```

`Data` has no methods, model reference, or close operation. Keeping a reference keeps the
values. Dropping references lets normal garbage collection release them. Never mutate
published arrays, schema, pages, or indices. A new value represents a change.

`createData(schema, version, batches)` constructs a complete value from `RowBatch` and
`SampleBatch` inputs. Batches describe disjoint cells: duplicate static values or row identities
reject instead of overwriting. To change static data or topology, construct a fresh value;
unchanged immutable column buffers can be supplied again without copying their payloads.

`appendData(previous, version, sampleBatches)` accepts only new sampled observations. It shares
existing pages and buffers, and rejects row batches, corrections, and backfilling into a field's
committed frame range. Row and column tiles of one append are validated together, so a batch can
arrive in pieces. Frame-number gaps and duplicate coordinates remain supported; coordinates must
not move backwards. Neither helper accepts `replace` or mutates earlier `Data` values.

These are pure application storage helpers. They do not fetch, subscribe, retain a model, or keep
global history. Your application decides which values to hold, persist, or discard.

## Locate an observation

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

## Observe independently of commands

```ts
import { transactions } from '@latkit/model';
import type { Model } from '@latkit/model';

async function observe(model: Model, signal: AbortSignal) {
  const events = model.monitor([{ from: 'Bus', select: ['voltage'] }], { signal });
  for await (const data of transactions(model.schema, events)) {
    show(data); // Each value contains just this transaction's supplied pages.
  }
}
```

A subscription begins when `monitor` is invoked and delivers ordered `begin`, `data`, `end`
transactions. The initial transaction may supply current state. There is no historical
cursor, replay, retained handle, or query operation on a model. A producer uses bounded
delivery buffers and backpressure, or fails a slow subscription with `resource-limit`.
Return the iterator or abort its signal to unsubscribe, including a pending pull.

Commands neither start nor reset nor complete subscriptions. A model need not have any
commands. An application's command scheduler and observation publisher remain independent.
`transactions` assembles complete publications without accumulating previous transactions;
to keep history, the application collects `event.block` values through the transaction end and explicitly appends
its sampled batches to its own `Data`. The `transactions(schema, events)` convenience helper
continues to yield a fresh `Data` for each complete transaction.

## Identity, layout, and validation

`Data.version` names an immutable value. `Index = { source, type, version }` identifies a
physical row numbering, which can stay unchanged across many data versions. References carry
the target type's index; incompatible indices fail rather than joining unrelated rows.
String IDs are optional pages used for domain-ID selection. Sample pages carry absolute
frame numbers and Float64 coordinates, independently of their numeric field precision.

Schema declares column types, nullability, spatial meaning, and the sample axis. It does
not advertise query capabilities: local `read` implements all four operations. Use
`validateSchema`, `validateDataEvent`, and `validateBlock` at trust boundaries. Storage
helpers expect validated column layouts; they additionally check schema/row-space compatibility,
disjoint cells, and append boundaries without rescanning stored payloads. `DataEvent` carries a
`block: DataBatch`; the former patch types, event payload, and replacement option are removed.

Queries yield one schema header followed by byte-bounded blocks. Contiguous reads share
immutable typed-array views. Sparse selections and batched small sample pages may copy.
Use `buffers: 'owned'` for independent allocations you may mutate or transfer; never detach
application-owned buffers. Local filtering and reductions require the relevant fields to
have been supplied. They never ask a model for missing values.

## Breaking migration

Delete `Queryable`, `Recording`, `retain`, retained budgets, model `query`/`export`/`on`,
and `Routine.records`. Replace `describe()` with `.schema`. Move `run` and `routines` to
`Commands`. Replace provider implementations with passive `Model.monitor` delivery and
application-owned `Data`; call `read(data, query)` locally. Views take `source: data` and
receive updates through `view.set({ source: nextData })`. Values remain usable after
unsubscribe, connection closure, or view destruction.

[API](https://latkit.readthedocs.io/en/latest/api/reference/model/index.html)
