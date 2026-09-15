# @latkit/remote

## 0.4.0

### Minor Changes

- 2019574: Use one append-only Series API for memory, files, and remote recordings.

  - Breaking: Series now exposes committed state, bounded strided reads, time lookup, and append events. Use createSeries for initial arrays or retained RunFrames; sample is asynchronous.
  - Breaking: RunFrames requires resultId and supports float64 values and sparse element indices. Results requires id and series(classId). connectResults takes that result id.
  - Breaking: Monitor.load accepts Series; extend, loadSource, refreshSource, and monitor-specific source types are removed. Append to the history; the monitor subscribes automatically.
  - Added: independent colorRange, error/rendered/valueRange events, bounded history and focus reads, cancellation, incremental append rendering with stable mappings, and float64 normalization before GPU upload.
  - Fixed: segment clipping, focus compositing, and canonical Viridis, Inferno, Plasma, and Magma tables. Bundled palette functions are cached.
  - Breaking: monitor JSON uses float64 time and values with optional uint32 elements; every supplied frame is committed and ranges are computed from samples.

### Patch Changes

- 2019574: Include the repository's MIT license in the published package tarballs.
- Updated dependencies [2019574]
- Updated dependencies [2019574]
  - @latkit/model@0.5.0
  - @latkit/port@0.2.1

## 0.3.1

### Patch Changes

- 196e170: `connectSource` forwards a run's abort signal to the runner stream, so cancelling a run stops the serving side, and `reopen` transfers an owned copy of the bytes instead of a view over a buffer the caller may still hold.
- Updated dependencies [196e170]
- Updated dependencies [196e170]
  - @latkit/model@0.4.0

## 0.3.0

### Minor Changes

- 4219e1e: Add `Remote<T>`, the shape every connected side shares: what the peer serves plus `close`. `connectResults` returns `Remote<Results>` and `RemoteSource` is a `Remote<Served>` with `reopen`; the `RemoteGrid`, `RemoteResults`, `ServeOptions`, and `ResultsOptions` names are gone, their shapes stated inline on `connectGrid`, `serveSource`, and `serveResults`.

### Patch Changes

- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
  - @latkit/model@0.3.0
  - @latkit/port@0.2.0

## 0.2.0

### Minor Changes

- 299e99f: Add `serveResults` and `connectResults`: a `Results` served across a port, one class's batches per stream, with an optional `maxSignals` bound on what one read may select.

### Patch Changes

- Updated dependencies [299e99f]
  - @latkit/model@0.2.0

## 0.1.0

### Minor Changes

- e65dc17: Add `@latkit/remote`: a `@latkit/model` model served across a `@latkit/port`. `serveSource` and
  `connectSource` carry a source, its runner as one stream, and the reopen that continues a lineage;
  `serveGrid` and `connectGrid` carry a grid as its header and windows of display text.

### Patch Changes

- Updated dependencies [e65dc17]
  - @latkit/port@0.1.0
