---
'@latkit/model': major
'@latkit/connect': major
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
'@latkit/video': minor
---

Move the CPU data layer from gpu into model as one bounded `Reader`, and drop the data version.

Added

- `createReader`, `Reader`, `ReadScope` in model: memoized reads, joined fields, and extents under one budget.
- `sampleDomain(pages)` in model.
- `gpu.reader`, `frame.reader`, `kit.fieldScale`, `kit.wiring`.
- `protocol` namespace export in connect.
- `pixelRatio` option for `exportVideo`.

Changed

- `createData(schema, batches)` and `appendData(previous, batches)`.
- Reads yield blocks only; `RowsBlock.position` is `rowOffset`; `TableData.ids` is `ColumnPages`.
- `FieldInput`, `FieldBinding`, `FieldValues`, `FieldsRequest`, `FieldsBlock` (was `NativeFields`), and `ExtentRequest` live in model; `ExtentRequest` takes `{ source, from, rows, field, window }`.
- `frame.upload` takes a `FieldsBlock` or `EnvelopeBlock`; `GpuPage.native` is `GpuPage.block`.
- `BufferData` and `TextureData` report `revision`.
- App-facing gpu types (`CompositionConfig`, `GpuStats`, `Budget`, `ImageOptions`, `TextOptions`, `ColormapOptions`, `ShadeFrame`, …) moved from `kit` to the root export.
- Field shader header is seven words; kinds are named `FIELD_*` constants.
- Connect frames carry no version field; the magic is `LATK` and the opcode is u32. Binary descriptors use `type: 'float32' | …`. `connectLattice` is `connectModel`; `maxBatchBytes` is `maxBlockBytes`.
- `exportVideo` keeps the view's `at` when no `at` mapping is given.
- Monitor `fit()` with no readings fits the recorded window; following appends no longer scans every page, and cached tiles before the window are pruned as it advances.
- Diagram re-reads its scene for a new `at` only when a sampled field is bound, and checks edge-end indices.

Removed

- `Data.version`, `QueryHeader`, block `version` fields, and monitor `Reading.version`.
- `Gpu.query`, `Gpu.fields`, `Gpu.envelope`, `frame.query`, `frame.fields`, `frame.envelope`, `frame.extent`, `frame.values`, `frame.scale`, `kit.createNativeReader`, `kit.NativeReader`, `kit.QueryResult`.
- The `@latkit/connect/protocol` subpath.
