# @latkit/model

## 0.6.0

### Minor Changes

- b2631b8: Add `@latkit/diagram`, a WebGPU block-diagram renderer and editor surface, and its netlist in `@latkit/model`.

  - Added: `Netlist` in `@latkit/model`, a block diagram's structure as columns: blocks, the ports each block owns, and the nets that join ports, with optional kinds, sides, tag-drawn nets, groups, keys, and labels. `validateNetlist` checks offsets, ranges, one driver and one kind per net, one net per port, unique keys, and label lengths, and throws an `Error` naming the first invalid field.
  - Added: `createDiagram(options)` in `@latkit/diagram`, a durable controller with the lifecycle of `Network` and `Monitor`: it takes neither a device nor a canvas, `attach` leases a device from the shared pool, `detach` keeps every state, a lost device is recovered in place, and `destroy` forgets the netlist and gives back the memory derived from it. `CHANNELS` and `OPTIONS` name what it speaks, and `validateOptions` checks an option patch before a device exists.
  - Added: automatic layout in layers along the signal flow with feedback returning underneath, one layout per unit shape, units packed six grid steps apart, right-angle wire routing with trunks, junctions, and arrows, and in-canvas text from a runtime glyph atlas. Every size derives from the `gridPitch` option, and blocks grow until no text collides.
  - Added: channels for block placement, block and net color and visibility, block and port status, dashes marching along nets, and shade values. The `blockPosition` channel places blocks, and a NaN pair hands a block back to its automatic position.
  - Added: `load` keeps every block whose `blockKey` survives where it was, with its placement and selection, lands new blocks beside what they connect to, and fades out removed ones. Every other channel clears.
  - Added: `fit(parts)` and `reveal(part, { neighbors })` frame some parts without redefining the fit view the `fit` event reports on.
  - Added: editing proposals. Under `interaction: 'edit'`, drawing a wire emits `connect`, dragging or nudging blocks emits `move`, and Delete emits `delete`; the diagram never edits its netlist, and a host loads the result it accepts.
  - Added: a `Shade` fragment hook for the block, port, wire, and group passes, reading `u.host` and `u.pointer_px`.
  - Added: `@latkit/diagram/layout` exports `arrange(netlist, { gridPitch })`, the same pure, deterministic layout without a device or a DOM, for a worker.

## 0.5.0

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
