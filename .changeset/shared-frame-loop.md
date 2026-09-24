---
'@latkit/gpu': minor
'@latkit/network': patch
'@latkit/monitor': patch
---

Drive every renderer's frames from one shared scheduler.

- Added: `createFrameLoop(presentation, render, options?)` in `@latkit/gpu`, one canvas's frame scheduler: coalesced wakes, a re-render before the next paint whenever the canvas resizes (the observer's initial notification included), and a backing store quantized up while a resize is in flight that snaps exact once the size holds. `render` receives the frame's time, CSS size, backing scale, and whether the size has settled, and returns true to be called again. `{ quantize: false }` sizes the backing store exactly on every frame, for a renderer that repaints everything on any size change.
- Changed: `@latkit/network` renders on `createFrameLoop`. A still view now stops scheduling after its last frame instead of arming one more guard frame.
- Changed: `@latkit/monitor` renders on `createFrameLoop` without quantizing: resize, cursor, and presenting a lane share one frame, and a resize still reallocates and repaints once.
- Changed: `@latkit/monitor` emits `rendered` only once the canvas has a layout size, like the network's `painted`; a canvas without area presents nothing until the resize that gives it area.
- Fixed: in `@latkit/network` and `@latkit/monitor`, a `detach()` or `attach()` made from a `deviceLost` handler, or from the `attached: false` (and network `painted: false`) the release emits first, now supersedes the device-loss recovery instead of being undone by it. `deviceLost` reports `recovering: false` when such a call came before it, since no recovery follows.
