# @latkit/video

Export any Latkit GPU renderer to MP4 (H.264) or WebM (VP9). The exporter uses the
same preparation, rendering, native model coordinates, colors, text, and resource
management as interactive views. It has no renderer-specific data format or worker.

```ts
import { exportVideo, type VideoWrite } from '@latkit/video';

const file = await fileHandle.createWritable();
const output = new WritableStream<VideoWrite>({
  write: ({ position, bytes }) => file.write({ type: 'write', position, data: bytes }),
});
try {
  const result = await exportVideo({
    gpu,
    renderer: exportRenderer,
    width: 1920,
    height: 1080,
    duration: 10, // output seconds
    frameRate: 60,
    at: (seconds) => 20 + seconds, // native model coordinate
    format: 'mp4',
    output,
    signal,
    onProgress: ({ completedFrames, totalFrames }) => {
      console.log(completedFrames / totalFrames);
    },
  });
  await file.close();
} catch (error) {
  await file.abort();
  throw error;
}
```

`duration` includes a possibly shorter last frame. Timestamps derive independently
from frame number; fractional rates do not accumulate rounding errors. Container
timebases can introduce small timing quantization. `at` maps output seconds to a
native coordinate; omit it for static data. Shared GPU effects receive output time
in milliseconds. Quality defaults to `high`; choose `medium` or `very-high`, or set
an explicit `bitrate` in bits/second instead of `quality`.

## Ownership and composition

The caller supplies and owns the GPU, renderer, sources, and destination. Use a
dedicated renderer over retained acquisitions for deterministic exports. Do not
mutate or render that renderer (including composed children) during an export.
Export releases its writer lock on every exit, but never closes or aborts the
caller's stream. Positional writes may overwrite earlier bytes; a destination must
honor `position`. Write bytes are stable and may be retained by the destination.

Composition belongs to GPU and works for interactive rendering and export alike:

```ts
import { createComposition } from '@latkit/gpu';

const renderer = createComposition({
  gpu,
  views: [
    { renderer: network, region: { x: 0, y: 0, width: 1, height: 0.6 } },
    { renderer: monitor, region: { x: 0, y: 0.6, width: 1, height: 0.4 } },
  ],
});
try {
  await exportVideo({ gpu, renderer, output, width: 1920, height: 1080, duration: 10 });
} finally {
  renderer.destroy(); // releases panel textures, not network or monitor
}
```

## Performance

Each frame waits for complete progressive preparation before GPU capture. Capture
passes an OffscreenCanvas to WebCodecs without a JavaScript pixel readback; browser
and codec internals may still copy. Submission and texture lifetimes remain owned
by the shared GPU. The encoder queue is bounded to four frames, and awaited writes
propagate destination backpressure. Encoded writes are at most 256 KiB. A single
copy at that boundary gives caller-owned asynchronous writes stable bytes even
when cancellation tears down the muxer.

MP4 uses approximately one-second fragments; WebM uses approximately one-second
clusters and a seek index. GPU textures and queued frames do not grow with duration.
WebM seek metadata grows with cluster count, and media memory depends on resolution,
bitrate, codec, and keyframe size. The exporter never collects a whole output file.
A caller that retains every write will, naturally, retain that file in memory.

Use an application-owned worker for CPU/codec isolation. Construct GPU and renderer
inside that worker and stream output to storage there. Renderer objects are not
serializable, and the package does not hide another GPU owner or scene conversion.
See [the worker example](../../examples/video/src/worker.ts).

## Verification

`pnpm --filter @latkit/video test` checks timing and destination ownership.
Run `pnpm --filter @latkit/video-example dev`, then open `/check.html` for headed
real-codec checks: decoded composition pixels, progressive completion, partial
last frames, 1080p scaling, slow writes, cancellation, and failure cleanup. The main
page exports and decodes network, monitor, and combined scenes in a worker.
