# Export video

Record any view to MP4 (H.264) or WebM (VP9). It needs WebGPU and a browser WebCodecs encoder for
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

`duration` is in output seconds, and `at` maps them to model coordinates; without it, the view's
`at` holds. `pixelRatio` scales lines and text as it does for images.

The view's canvas pauses while it records; keep its sources fixed until the export ends. Writes are
positional, and the export awaits each one, so storage sets the pace. The export borrows the
stream's writer and never closes it.

Record a [composition](views.md#compose) to combine views. The
[worker example](https://github.com/lukelowry/latkit/blob/main/examples/video/src/worker.ts) exports
in the background.

[API](https://latkit.readthedocs.io/en/latest/api/reference/video/index.html)
