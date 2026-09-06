# @latkit/monitor

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
