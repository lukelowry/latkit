---
'@latkit/gpu': minor
---

Add `createDevicePool()`, a factory returning the `DevicePool` interface, in place of the `DevicePool` class: one device shared by many renderers through reference-counted leases, with concurrent acquisitions coalesced and a lost device retired so the next acquisition requests a replacement. `Presentation.observe()` replaces `observeCanvas()`, reporting device-pixel size and pixel ratio for the presentation's own canvas, and `PresentationCanvas` is no longer exported.
