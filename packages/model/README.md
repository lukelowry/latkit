# @latkit/model

Immutable columnar data, bounded local reads, and the `Model` contract for Latkit.

```sh
npm install @latkit/model
```

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

for await (const block of read(source, { kind: 'rows', from: 'Bus', select: ['load'] }))
  console.log(block.columns.load);
```

`source` is a `Data` value, ready for any Latkit view.

| Call                                   | Use                                                         |
| -------------------------------------- | ----------------------------------------------------------- |
| `createData(schema, batches)`          | A complete value from row and sample batches                |
| `appendData(previous, batches)`        | A new value with sampled observations appended              |
| `read(data, query, options)`           | Bounded local rows, samples, aggregates, and envelopes      |
| `createReader(options)`                | Memoized reads, joined fields, and extents in a memory pool |
| `createMemory(budget)`                 | One budget for the reads, uploads, and GPU resources        |
| `locateSample(pages, at)`              | The last observation at or before a coordinate              |
| `appendedPages(before, after)`         | The pages an append added, or `undefined` for a replacement |
| `selectBatches(data, fields, options)` | Selected fields of a value as batches, for a model          |
| `staticFields`, `sampledFields`        | Selections of every static or sampled field of a schema     |
| `failure(code, message, details)`      | The `Failure` every Latkit package throws                   |

Check untrusted input with `validateSchema`, `validateSelection`, `validateBatch`, and
`validateBlock`.

A `Model` has a `name`, a `schema`, an optional `monitor` that yields batches, and `commands`. Each
command is a `CommandDescription` of `Parameter`s with a `run(values, context)`; `Arguments` infers
its values. A handler gets the same `CommandContext` in process and across `@latkit/connect`, and
throws a `failure` to report a code, such as `invalid-input`, to its caller.

[Data](https://latkit.readthedocs.io/en/latest/document-sessions.html) ·
[Models](https://latkit.readthedocs.io/en/latest/ports-and-protocols.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/model/index.html)
