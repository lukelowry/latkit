# @latkit/video

Export a GPU renderer to MP4 (H.264) or WebM (VP9).
Requires WebGPU and browser support for the selected WebCodecs encoder.

```ts
import { exportVideo, type VideoWrite } from '@latkit/video';

const file = await fileHandle.createWritable();
const output = new WritableStream<VideoWrite>({
  write: ({ position, bytes }) => file.write({ type: 'write', position, data: bytes }),
});
try {
  await exportVideo({
    gpu,
    renderer,
    output,
    width: 1920,
    height: 1080,
    duration: 10,
    frameRate: 60,
    format: 'mp4',
    at: (seconds) => 20 + seconds,
    signal,
    onProgress: ({ completedFrames, totalFrames }) => console.log(completedFrames / totalFrames),
  });
  await file.close();
} catch (error) {
  await file.abort();
  throw error;
}
```

`duration` is output seconds; `at` maps them to native model coordinates.
Omit `at` for static data. Choose `quality: 'medium' | 'high' | 'very-high'`
or an explicit `bitrate` in bits per second.

Use a dedicated renderer over retained data. Do not mutate or render it elsewhere
during export. The exporter borrows the GPU, renderer, sources, and output stream;
it releases its writer lock but does not close or abort your destination.

Writes are positional and may replace earlier bytes. Honor `position` and await
storage writes for backpressure. Each frame waits for complete preparation.

Use `createComposition` from `@latkit/gpu` to combine views.
See the [worker example](../../examples/video/src/worker.ts) for background export.

[API](https://latkit.readthedocs.io/en/latest/api/reference/video/index.html)
