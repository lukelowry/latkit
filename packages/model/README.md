# @latkit/model

TypeScript data contracts and utilities for Latkit. Your application implements
the model; renderers and transports consume the same interfaces.

| Interface   | Purpose                                                 |
| ----------- | ------------------------------------------------------- |
| `Queryable` | Discover schema, stream queries, retain a fixed version |
| `Model`     | Query data, run routines, open recordings               |
| `Recording` | Read the sampled output of the latest recording command |

## Run and read

Given a model with a `solve` routine and sampled `Bus.Vm` field:

```ts
import type { Model } from '@latkit/model';

async function solve(model: Model) {
  const recording = await model.monitor([{ from: 'Bus', select: ['Vm'] }]);
  try {
    await model.run({ routine: 'solve', values: {} });
    for await (const block of recording.query({
      kind: 'samples',
      from: 'Bus',
      select: ['Vm'],
      window: { kind: 'frames', offset: 0, count: recording.frames },
    })) {
      if (block.kind === 'samples') console.log(block.coordinates, block.columns.Vm);
    }
  } finally {
    await recording.close();
  }
}
```

Open recordings before running a command. Commands execute in order.
Each recording command replaces the monitor's previous frames; use `retain()`
to keep a result across subsequent commands.

## Keep a fixed result

```ts
const fixed = await recording.retain({
  window: { kind: 'range', between: [0, 10] },
  maxBytes: 64 * 1024 * 1024,
});
try {
  // Pass fixed to a renderer or issue several coherent queries.
} finally {
  await fixed.close();
}
```

Retained acquisitions are independent and must be closed. Cancellation interrupts
work; it does not roll back commands that already ran.

## Read native columns

```ts
import { numberAt, textAt, sampleAt, validateSchema } from '@latkit/model';

const problems = validateSchema(await source.describe());
const voltage = numberAt(numericColumn, 0);
const name = textAt(textColumn, 0);
const value = sampleAt(sampleColumn, { row: 0, frame: 0 });
```

Topology is data: a reference field holds rows of another type, read as a
`ReferenceColumn` of row numbers under that type's `Index`.

```ts
for await (const block of source.query({ kind: 'rows', from: 'Branch', select: ['bus1'] })) {
  const bus1 = block.kind === 'rows' ? block.columns.bus1 : undefined;
  if (bus1?.kind === 'reference') console.log(bus1.index.type, numberAt(bus1, 0)); // 'Bus', a row
}
```

Queries yield one schema header, then bounded blocks. Rows use physical ranges
or indices; `Index = { source, type, version }` identifies their numbering.
Columns use typed arrays, offsets, and validity bitmaps.

Borrowed blocks are immutable. Request `buffers: 'owned'` when you need to
transfer their backing buffers. Consume or return each query iterator.
Use `validateQuery` and `validateBlock` at data boundaries.

[API](https://latkit.readthedocs.io/en/latest/api/reference/model/index.html)
