# @latkit/monitor

## 0.4.1

### Patch Changes

- b2631b8: Drive every renderer's frames from one shared scheduler.

  - Added: `createFrameLoop(presentation, render, options?)` in `@latkit/gpu`, one canvas's frame scheduler: coalesced wakes, a re-render before the next paint whenever the canvas resizes (the observer's initial notification included), and a backing store quantized up while a resize is in flight that snaps exact once the size holds. `render` receives the frame's time, CSS size, backing scale, and whether the size has settled, and returns true to be called again. `{ quantize: false }` sizes the backing store exactly on every frame, for a renderer that repaints everything on any size change.
  - Changed: `@latkit/network` renders on `createFrameLoop`. A still view now stops scheduling after its last frame instead of arming one more guard frame.
  - Changed: `@latkit/monitor` renders on `createFrameLoop` without quantizing: resize, cursor, and presenting a lane share one frame, and a resize still reallocates and repaints once.
  - Changed: `@latkit/monitor` emits `rendered` only once the canvas has a layout size, like the network's `painted`; a canvas without area presents nothing until the resize that gives it area.
  - Fixed: in `@latkit/network` and `@latkit/monitor`, a `detach()` or `attach()` made from a `deviceLost` handler, or from the `attached: false` (and network `painted: false`) the release emits first, now supersedes the device-loss recovery instead of being undone by it. `deviceLost` reports `recovering: false` when such a call came before it, since no recovery follows.

- Updated dependencies [b2631b8]
- Updated dependencies [b2631b8]
  - @latkit/model@0.6.0
  - @latkit/gpu@0.4.0

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
  - @latkit/gpu@0.3.1
  - @latkit/model@0.5.0

## 0.3.0

### Minor Changes

- 196e170: One durable controller, as on `Network`. `createMonitor(options)` is synchronous and takes neither a device nor a canvas; `attach(canvas)` leases a device and paints the retained series, signal, frontier, selection, and options, `detach()` keeps them, and a lost device is replaced inside the controller.

  - Added: `attach`, `detach`, `attached`, the `attached` event, `recovering` on `deviceLost`, the `OPTIONS` registry, and `validateOptions`.
  - Changed: `setOptions` replaces `setColormap` and `setValueRange` (`valueRange: null` fits the committed extent); `select(element | null)` replaces `setFocus`; the `select` event replaces `pick`, and pointer-down selects the element it reports.
  - Removed: the device and canvas arguments to `createMonitor`, and the `Series` and `Domain` re-exports. Import them from `@latkit/model`.
  - Faster: the auto-fit range grows from newly committed frames only, switching signals no longer reallocates GPU storage, and the focus trace uploads incrementally.

- 196e170: Add `timeRange` (a window over the series' time axis; null shows the whole span), `focusColor` (null brightens the selected trace's own color), and `unselectedAlpha` (the alpha of every other trace while an element is selected). Readings map the cursor through the window.

### Patch Changes

- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
  - @latkit/gpu@0.3.0
  - @latkit/model@0.4.0

## 0.2.0

### Minor Changes

- 4219e1e: `Series` is `@latkit/model`'s: `time` is a `Float64Array`, and `ranges` stays optional. Nothing else changes.

### Patch Changes

- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
  - @latkit/gpu@0.2.0
  - @latkit/model@0.3.0

## 0.1.0

### Minor Changes

- 73786c4: Require application-owned native Core `GPUDevice` and `HTMLCanvasElement` instances so device sharing, canvas layout, and DOM ownership stay explicit.

### Patch Changes

- Updated dependencies [73786c4]
  - @latkit/gpu@0.1.0

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
