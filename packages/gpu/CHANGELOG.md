# @latkit/gpu

## 0.2.0

### Minor Changes

- 4219e1e: Add `createDevicePool()`, a factory returning the `DevicePool` interface, in place of the `DevicePool` class: one device shared by many renderers through reference-counted leases, with concurrent acquisitions coalesced and a lost device retired so the next acquisition requests a replacement. `Presentation.observe()` replaces `observeCanvas()`, reporting device-pixel size and pixel ratio for the presentation's own canvas, and `PresentationCanvas` is no longer exported.

## 0.1.0

### Minor Changes

- 73786c4: Add native Core WebGPU device acquisition and shared canvas presentation primitives with explicit caller ownership.
