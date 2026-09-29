# @latkit/video

## 0.1.1

### Patch Changes

- f694ea4: Render Monitor ticks, labels, gridlines, and playheads on the GPU, with serializable axis formatting and custom ticks. Live views and video exports share one plot assembly, including layout and captured glyphs. Add `Monitor.seek()` and `Monitor.toData()`; axes are enabled by default and can be hidden with null axis options.

  Move Diagram's SDF glyph infrastructure into GPU's root API. Textures track their own upload revisions, snapshots preserve glyph appearance across realms, and bounded atlases fail explicitly on exhaustion. Diagram retains its anchor-based glyph positioning and culling.

  Reuse Monitor upload buffers, bound folded-history carry storage, coalesce hover requests, and cache the latest sampled frame within a byte budget. Keep retained-image remapping during resize and enforce texture and buffer limits. Offscreen preparation uses the same awaitable sampling scheduler as interactive rendering.

  Add opt-in drag/pinch/wheel navigation, anchored `zoom`, CSS-pixel `pan`, and `fit` to Monitor.
  Retained textures respond immediately; the latest view refines after gestures settle, with exact
  readings against displayed ranges. Add asynchronous `setShade` composition with the same host
  uniform and snapshot conventions as Network and Diagram. Share shader failure diagnostics
  through GPU and preserve animated WGSL in video exports without rereading history.

- Updated dependencies [f694ea4]
  - @latkit/gpu@0.7.0
  - @latkit/monitor@0.7.0
  - @latkit/diagram@0.3.1
  - @latkit/network@0.12.1

## 0.1.0

### Minor Changes

- Add renderer-owned scene snapshots and deterministic worker video exports. `@latkit/video` composes network, diagram, and monitor views on the GPU, reads pinned series through bounded port requests, and encodes MP4 or WebM with cancellation, progress, and optional streamed output. Shared render targets and awaitable channel preparation reuse existing renderer engines. Diagram snapshots retain layout and glyphs; monitor exports reuse history rendering and add a synchronized playhead.

  Validate series state before publishing it, preserve failed connection errors, and reject malformed sample blocks before transport. Video cancellation releases resources even when a destination stalls.

### Patch Changes

- Updated dependencies
  - @latkit/gpu@0.6.0
  - @latkit/port@0.7.0
  - @latkit/model@0.10.1
  - @latkit/network@0.12.0
  - @latkit/diagram@0.3.0
  - @latkit/monitor@0.6.0
