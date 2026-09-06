# @latkit/model

## 0.4.0

### Minor Changes

- 196e170: - Added: `RGBA` and `Colormap` types, `validateRgba`, `bakeColormap` with `COLORMAP_LUT_SIZE`, and `createEmitter`; the one home for the color vocabulary and the event dispatcher every renderer shares.
- 196e170: Add `Domain`, the `[min, max]` every renderer takes, with `extent(values)` to scan one and `validateDomain(value, name)` to check one, and `validateTopology`, the topology check a host runs before a device exists (moved here from `@latkit/network`).

## 0.3.0

### Minor Changes

- 4219e1e: Add `Field` and `FieldRef`, the identity of one quantity of a class a host binds or plots, with `fieldsOf` and `fieldKey`. `Topology`, `Item`, and `Series` are now the one definition every renderer imports; `Series.ranges` is optional so a hand-built series need not carry it. `Loader` and `signalIndex` are no longer exported.

## 0.2.0

### Minor Changes

- 299e99f: Add `Results`, the interface for what a run leaves behind: its recorded samples read back class by class as the `RunFrames` batches the run streamed. `collect` now also folds an async stream of batches, filling a preallocated series when the frame count is known.

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
