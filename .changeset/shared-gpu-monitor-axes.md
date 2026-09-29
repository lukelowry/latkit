---
'@latkit/gpu': minor
'@latkit/monitor': minor
'@latkit/diagram': patch
'@latkit/network': patch
'@latkit/video': patch
---

Render Monitor ticks, labels, gridlines, and playheads on the GPU, with serializable axis formatting and custom ticks. Live views and video exports share one plot assembly, including layout and captured glyphs. Add `Monitor.seek()` and `Monitor.toData()`; axes are enabled by default and can be hidden with null axis options.

Move Diagram's SDF glyph infrastructure into GPU's root API. Textures track their own upload revisions, snapshots preserve glyph appearance across realms, and bounded atlases fail explicitly on exhaustion. Diagram retains its anchor-based glyph positioning and culling.

Reuse Monitor upload buffers, bound folded-history carry storage, coalesce hover requests, and cache the latest sampled frame within a byte budget. Keep retained-image remapping during resize and enforce texture and buffer limits. Offscreen preparation uses the same awaitable sampling scheduler as interactive rendering.

Add opt-in drag/pinch/wheel navigation, anchored `zoom`, CSS-pixel `pan`, and `fit` to Monitor.
Retained textures respond immediately; the latest view refines after gestures settle, with exact
readings against displayed ranges. Add asynchronous `setShade` composition with the same host
uniform and snapshot conventions as Network and Diagram. Share shader failure diagnostics
through GPU and preserve animated WGSL in video exports without rereading history.
