# @latkit/video

Export network, diagram, and monitor scenes as MP4 (H.264) or WebM (VP9). The package owns the worker, GPU rendering and composition, sample transport, encoder, and container. No application worker or animation loop is required.

```ts
import { exportVideo } from '@latkit/video';

const video = await exportVideo({
  views: [network.snapshot(), monitor.snapshot()],
  layout: 'column',
  timeRange: [0, 10],
  width: 1920,
  height: 1080,
  frameRate: 60,
  format: 'mp4',
  quality: 'high',
  signal: abortController.signal,
  onProgress: ({ completedFrames, totalFrames }) => {
    progress.value = completedFrames / totalFrames;
  },
});
const url = URL.createObjectURL(video);
// Use for playback/download; revoke the URL when finished.
```

For large exports, stream to a positional sink instead of retaining the encoded file in memory:

```ts
const handle = await showSaveFilePicker({
  suggestedName: 'simulation.mp4',
  types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
});
await exportVideo({
  views: [diagram.snapshot()],
  timeRange: [0, 30],
  width: 1920,
  height: 1080,
  output: await handle.createWritable(),
});
```

The exporter locks the sink, closes it only after successful finalization, and requests its abort on error or cancellation. Cancellation covers finalization and always releases exporter resources; it does not wait for an unresponsive sink. Custom sinks should honor their stream controller's abort signal. A file already committed by the sink cannot be rolled back. Custom `WritableStream<VideoWrite>` sinks must honor each write's `position`; container writes are not necessarily sequential. File access remains the application's decision. Streamed MP4 uses fragmentation to bound muxer metadata; buffered MP4 uses fast-start metadata.

## Scenes and time

Each renderer owns its `Scene` type and `snapshot()` method. Snapshots copy static structure, channel values, camera, selection, and style, including a baked colormap. Diagram snapshots preserve effective block positions and rasterized glyphs so worker output uses the same font. A scene can also be constructed directly for batch exports.

Series remain borrowed. At export start, each distinct series is pinned to its committed prefix and read lazily across `@latkit/port`; appends do not alter the video. Keep the underlying recording readable until export settles. Exports do not seek, pause, attach, or destroy your interactive controllers.

`timeRange` selects source seconds, with an exclusive end. `rate` is source seconds per output second (default 1). Frames use integer microsecond timestamps; the final frame is shortened to end at the requested duration, rounded to a microsecond. Channels use the same sample selection as interactive playback. No interpolation is introduced. All panels sample one source clock. Network orbit and diagram flow animate against output time. Monitor history is drawn once; its playhead moves across the same time range.

`row` and `column` split the output into equal panels. Width and height are positive even integers. Snapshots preserve the logical viewport so increasing resolution keeps label and stroke proportions. A camera following fit reframes for the panel's aspect ratio. Captured JavaScript shade callbacks do not execute in the worker: WGSL and current host uniforms are retained. Pointer/hover state, editing overlays, DOM legends, audio, and arbitrary UI are outside the scene export.

## Runtime and resources

Requires a secure browser context with worker WebGPU, OffscreenCanvas, and WebCodecs. The exact codec/size/frame-rate combination is checked before rendering; unavailable encoding fails explicitly. There is no real-time capture fallback. Browser and GPU drivers determine hardware acceleration; the API does not promise zero-copy encoding.

The worker renders each view into reusable GPU textures, composes them directly into an OffscreenCanvas, and submits VideoSamples with encoder backpressure. No per-frame CPU pixel readback or image transfer is used. Series reads are bounded; monitor history reuses its existing downsampling and GPU accumulation engine. GPU resources, data connections, and the worker are released on completion, cancellation, device loss, or error. Concurrent calls use independent workers/devices; schedule exports according to the host's GPU capacity.

Workers are distributed beside the package entrypoint and resolved with `new URL('./worker.js', import.meta.url)`. Use an ESM bundler with standard module-worker support (the example verifies Vite development and production builds), or serve the built files together. A webview's CSP must permit the packaged worker URL. The UI bundle does not import the encoder or render pipelines.

## Verification example

```sh
pnpm build
pnpm --filter @latkit/video-example dev
```

The example exports network signals, globe orbit, a 1080p network/monitor composition to an actual file stream, diagram flow, and WebM monitor history. It verifies dimensions/duration and decodes samples before offering downloads.
