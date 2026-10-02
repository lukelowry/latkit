# @latkit/video

Record any Latkit view to MP4 (H.264) or WebM (VP9) with WebCodecs.

```ts
import { exportVideo } from '@latkit/video';

await exportVideo(network, {
  output, // WritableStream<VideoWrite>
  width: 1920,
  height: 1080,
  duration: 10,
  at: (seconds) => 20 + seconds,
});
```

[Guide](https://latkit.readthedocs.io/en/latest/video.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/video/index.html)
