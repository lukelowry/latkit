# Export video

Record any view to MP4 (H.264) or WebM (VP9). Requires WebGPU and a browser WebCodecs encoder for
the format.

```ts
import { exportVideo, type VideoWrite } from '@latkit/video';

const file = await fileHandle.createWritable();
const output = new WritableStream<VideoWrite>({
  write: ({ position, bytes }) => file.write({ type: 'write', position, data: bytes }),
});
try {
  await exportVideo(network, {
    output,
    width: 1920,
    height: 1080,
    duration: 10,
    at: (seconds) => 20 + seconds,
    onProgress: ({ completedFrames, totalFrames }) => showProgress(completedFrames / totalFrames),
    signal,
  });
  await file.close();
} catch (error) {
  await file.abort();
  throw error;
}
```

`duration` is in output seconds; `at` maps them to model coordinates. Choose `format`,
`frameRate` (60 by default), and `quality` or an explicit `bitrate`.

The view's canvas pauses while it records. Keep its sources fixed for the export. Writes are
positional; honor `position` and await storage for backpressure. The exporter releases its writer
lock but never closes your destination.

Record a [composition](views.md#compose) to combine views. The
[worker example](https://github.com/lukelowry/latkit/blob/main/examples/video/src/worker.ts) exports
in the background.

[API](https://latkit.readthedocs.io/en/latest/api/reference/video/index.html)
