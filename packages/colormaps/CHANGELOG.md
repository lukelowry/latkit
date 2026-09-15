# @latkit/colormaps

## 0.2.1

### Patch Changes

- 2019574: Include the repository's MIT license in the published package tarballs.
- 2019574: Use one append-only Series API for memory, files, and remote recordings.

  - Breaking: Series now exposes committed state, bounded strided reads, time lookup, and append events. Use createSeries for initial arrays or retained RunFrames; sample is asynchronous.
  - Breaking: RunFrames requires resultId and supports float64 values and sparse element indices. Results requires id and series(classId). connectResults takes that result id.
  - Breaking: Monitor.load accepts Series; extend, loadSource, refreshSource, and monitor-specific source types are removed. Append to the history; the monitor subscribes automatically.
  - Added: independent colorRange, error/rendered/valueRange events, bounded history and focus reads, cancellation, incremental append rendering with stable mappings, and float64 normalization before GPU upload.
  - Fixed: segment clipping, focus compositing, and canonical Viridis, Inferno, Plasma, and Magma tables. Bundled palette functions are cached.
  - Breaking: monitor JSON uses float64 time and values with optional uint32 elements; every supplied frame is committed and ranges are computed from samples.

- Updated dependencies [2019574]
- Updated dependencies [2019574]
  - @latkit/model@0.5.0

## 0.2.0

### Minor Changes

- 196e170: - Removed: the `Colormap` type export; import it from `@latkit/model`, which `@latkit/colormaps` now depends on.
- 196e170: `gradient` takes a colormap function as well as a name, so a legend for a custom transfer function renders through the same sampler as the presets.

### Patch Changes

- Updated dependencies [196e170]
- Updated dependencies [196e170]
  - @latkit/model@0.4.0

## 0.1.0

### Minor Changes

- 4219e1e: Collapse the catalog into one frozen `COLORMAPS` registry (`{ label, kind }` per name, sequential entries first) and rename `colormapGradientCss` to `gradient`. `COLORMAP_NAMES`, `COLORMAP_KIND`, `COLORMAP_LABEL`, `isDiverging`, `ColormapKind`, and `ColormapGradientDirection` are removed; `ColormapName` is now `keyof typeof COLORMAPS`.

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
