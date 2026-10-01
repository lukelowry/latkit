# @latkit/video_new

Declaration-only public skeleton for the video rewrite. The root exports TypeScript declarations;
there is deliberately no runtime export or placeholder implementation. Build emits `.d.ts` files.
The existing `video/` package is untouched and is not a compatibility path.

Sources and `Gpu` are borrowed. Presentation uses `createCanvasView`; offscreen work uses `gpu.render`.
Destroying a renderer releases its own resources and subscriptions, never its sources or GPU owner.
All package imports use roots. Native model data and GPU field, text, color and resource plumbing
are the implementation boundary; no renderer-owned data format, atlas, device pool, or frame loop.

## Target usage

```ts
import { exportVideo } from '@latkit/video_new';

const result = await exportVideo({
  gpu,
  renderer: exportRenderer,
  width: 1920,
  height: 1080,
  frameRate: 60,
  frames: 600,
  at: (frame) => 20 + frame / 60,
  output,
  signal,
});
```

The host creates a dedicated renderer over explicitly retained sources when deterministic reads
are required. Each output frame uses the same `gpu.render` preparation/encoding/submission path;
`at` selects the native coordinate while `timeMs` derives from the output frame number.

Implementation still required: codec capability negotiation, render targets and readback/VideoFrame
transfer, bounded encoder queues, timestamp handling, container muxing, progress and cancellation.
The `WritableStream<VideoWrite>` accepts positional writes, including header rewrites, and applies
backpressure. The exporter borrows its writer lock and always releases it; the caller closes or
aborts the sink. Export owns only its targets and encoder resources. No renderer-specific scene
union, snapshot conversion or hidden worker/device acquisition is part of this API. Workers can
construct their GPU and renderer locally over connect-backed acquisitions.

See the compile-checked [consumer fixture](tests/contract.ts).
