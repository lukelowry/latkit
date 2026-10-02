# @latkit/connect

## 2.0.0

### Major Changes

- b958ddc: Move the CPU data layer from gpu into model as one bounded `Reader`, and drop the data version.

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

### Minor Changes

- b958ddc: Connect sizes publications for the wire, so producers never do.

  Added

  - `failure(code, message, details)` in model: the shared `Failure` constructor.
  - `sliceSamples(column, row, rows, frame, frames)` in model: a strided view of sample cells.

  Changed

  - `publish` and monitor yields deliver in the fewest messages within the negotiated limits. A group that fits stays one atomic message; batches share a message while they fit, and a larger sample batch is cut only between whole frames, so each message appends in turn. A row batch must still fit one message. `protocol.preparePublication` remains the strict one-message primitive.
  - `selectRows` resolves ID selections through a UTF-8 index of the ID pages instead of a retained string map.
  - Connect raises model's typed `failure`; errors reported by a peer keep the peer's code.

- b958ddc: Monitors draw streamed frames reliably: each image keeps what it has drawn and draws only what it is missing. Network picking stays fast at a million vertices.

  Added

  - `Progress.domain`: the coordinates a run covers, carried by connect.
  - `sampleFrames(pages, window)` in model: the frames a sample window covers.

  Changed

  - Monitor history draws, each frame, what an image is missing, continuing from the last frame drawn. Arrivals reach the shown image first; a new window or value range redraws behind it while the shown image stretches to the camera's axes. Fixed windows at epoch coordinates, and monitors created before any samples, now stream.
  - Monitor fitted values come from per-page extents, so appends never read history again.
  - Monitor limits are `{ rows, segmentsPerFrame, historyBytes, pickingBytes }`; `segmentsPerFrame` bounds the lines drawn per frame.
  - Network `pick` and hover use a compact hit-test index, built in the background within `limits.pickingBytes`: a million vertices and two million edges fit the default, and pick takes milliseconds instead of seconds. `stats().pickingBytes` counts the index as it builds.
  - A hover budget miss suspends automatic hover until the scene moves or the view can search faster, as when its index is built.
  - gpu field pages bind four value buffers, which needs five storage buffers per shader stage; pages keep every frame of their rows; buffers grow with use; cache eviction takes constant time in model and gpu.

  Removed

  - Monitor `camera.follow`, `detail`, `autoDomain`, `limits.frameMs`, `limits.observationsPerFrame`, `stats().pendingBytes`, and pointer pan and zoom.

### Patch Changes

- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
- Updated dependencies [b958ddc]
  - @latkit/model@2.0.0

## 1.0.1

### Patch Changes

- cad562f: Fix disconnections during backlog draining by coalescing cumulative ACKs per stream through a single outbound writer. Preserve terminal ACKs and stream reservations until they are sent. Socket and credit pressure now wait without an elapsed-time deadline; cancellation remains prompt and local shutdown stays bounded. Public APIs and the wire format are unchanged.

## 1.0.0

### Major Changes

- 5f19f4e: Replace connect with demand-driven connectLattice and acceptModel endpoints. Registration carries metadata only; bounded binary publications, cumulative credit windows, cancellation, typed command arguments, bounded diagnostics, and encoded forwarding replace snapshots and transaction event plumbing.

  Make model the shared data and command vocabulary: add CommandDescription, Parameters, Arguments, Progress, Diagnostic, validateBatch, validateSelection, and selectBatches. Remove Model, Commands, Routine, DataEvent, transactions, and schema delivery limits. Read limits belong to QueryOptions; connection limits belong to connect. Update GPU/monitor consumers accordingly. This intentionally breaks the previous connection and model contracts.

### Patch Changes

- Updated dependencies [5f19f4e]
- Updated dependencies [5f19f4e]
  - @latkit/model@1.0.0
