# @latkit/video

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
