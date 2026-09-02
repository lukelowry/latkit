# @latkit/model

## 0.2.0

### Minor Changes

- 299e99f: Add `Results`, the interface for what a run leaves behind: its recorded samples read back class by class as the `RunFrames` batches the run streamed. `collect` now also folds an async stream of batches, filling a preallocated series when the frame count is known.

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
