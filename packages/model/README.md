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

`createData` and `appendData` are pure application storage helpers over supplied patches.
They do not fetch, subscribe, retain a model, or keep a global history. `appendData(previous,
version, patches)` shares unchanged pages; row patches update their specified cells and
sample patches add observations. `replace: true` on a row patch starts a new table.
Use `createData` when you want to discard previous observations. Your application sets its
own history size, persistence, and eviction policy.

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
to keep history, the application explicitly appends delivered patches to its own `Data`.

## Identity, layout, and validation

`Data.version` names an immutable value. `Index = { source, type, version }` identifies a
physical row numbering, which can stay unchanged across many data versions. References carry
the target type's index; incompatible indices fail rather than joining unrelated rows.
String IDs are optional pages used for domain-ID selection. Sample pages carry absolute
frame numbers and Float64 coordinates, independently of their numeric field precision.

Schema declares column types, nullability, spatial meaning, and the sample axis. It does
not advertise query capabilities: local `read` implements all four operations. Use
`validateSchema`, `validateDataEvent`, and `validateBlock` at trust boundaries. Storage
helpers expect validated patches; they check schema/row-space compatibility without rescanning
every numeric cell on each append.

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
