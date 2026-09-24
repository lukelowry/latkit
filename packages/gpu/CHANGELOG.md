# @latkit/gpu

## 0.4.0

### Minor Changes

- b2631b8: Drive every renderer's frames from one shared scheduler.

  - Added: `createFrameLoop(presentation, render, options?)` in `@latkit/gpu`, one canvas's frame scheduler: coalesced wakes, a re-render before the next paint whenever the canvas resizes (the observer's initial notification included), and a backing store quantized up while a resize is in flight that snaps exact once the size holds. `render` receives the frame's time, CSS size, backing scale, and whether the size has settled, and returns true to be called again. `{ quantize: false }` sizes the backing store exactly on every frame, for a renderer that repaints everything on any size change.
  - Changed: `@latkit/network` renders on `createFrameLoop`. A still view now stops scheduling after its last frame instead of arming one more guard frame.
  - Changed: `@latkit/monitor` renders on `createFrameLoop` without quantizing: resize, cursor, and presenting a lane share one frame, and a resize still reallocates and repaints once.
  - Changed: `@latkit/monitor` emits `rendered` only once the canvas has a layout size, like the network's `painted`; a canvas without area presents nothing until the resize that gives it area.
  - Fixed: in `@latkit/network` and `@latkit/monitor`, a `detach()` or `attach()` made from a `deviceLost` handler, or from the `attached: false` (and network `painted: false`) the release emits first, now supersedes the device-loss recovery instead of being undone by it. `deviceLost` reports `recovering: false` when such a call came before it, since no recovery follows.

## 0.3.1

### Patch Changes

- 2019574: Include the repository's MIT license in the published package tarballs.

## 0.3.0

### Minor Changes

- 196e170: Add `devices`, the realm-wide `DevicePool` every controller leases from unless given another: one device per page, requested by the first `acquire` and destroyed with the last release. `Presentation.observe` relies on `device-pixel-content-box` where the browser supports it.

## 0.2.0

### Minor Changes

- 4219e1e: Add `createDevicePool()`, a factory returning the `DevicePool` interface, in place of the `DevicePool` class: one device shared by many renderers through reference-counted leases, with concurrent acquisitions coalesced and a lost device retired so the next acquisition requests a replacement. `Presentation.observe()` replaces `observeCanvas()`, reporting device-pixel size and pixel ratio for the presentation's own canvas, and `PresentationCanvas` is no longer exported.

## 0.1.0

### Minor Changes

- 73786c4: Add native Core WebGPU device acquisition and shared canvas presentation primitives with explicit caller ownership.
