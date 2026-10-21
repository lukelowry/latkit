# Pictures and video

A `Shot` is plain data: a size in pixels, and how views are drawn into it. It draws views whether or
not a canvas shows them; a canvas showing one holds its last frame meanwhile.

```ts
const shot = new Shot([3840, 2160]).scale(2); // 2 pixels a CSS pixel: 1920 by 1080 CSS pixels
const image = await shot.image([view]); // once the view is complete and still
const png = await image.encode('png'); // or 'jpeg' with { quality }, or 'webp'
image.destroy();
```

| Option          | Does                                                             |
| --------------- | ---------------------------------------------------------------- |
| `scale(n)`      | draws `n` pixels per CSS pixel                                   |
| `panels([...])` | where each view draws, `[x, y, width, height]` fractions         |
| `transparent()` | keeps alpha where the themes' backgrounds are                    |
| `deadline(s)`   | rejects with `timeout` after `s` seconds, readback included (30) |
| `elapsed(s)`    | fixes time-reading expressions and effects at `s` seconds        |

Files are encoded in a worker when workers are available; otherwise encoding runs on the calling thread.

## Video

`shot.video(gpu, fps, output)` encodes H.264 in MP4 with WebCodecs as frames are drawn, and writes
it to a `WritableStream`: a file handle's, or a buffer's. `record` steps the views to each frame's
time; returning `false` finishes the video.

```ts
const file = await (await showSaveFilePicker()).createWritable();
const video = new Shot([1920, 1080]).video(gpu, 60, file, { bitrate: 12e6 });
await video.record([view], (time) => {
  view.at = time;
  return time < 10;
});
```

Width and height are multiples of 4 and 2. A frame where nothing moved is held rather than drawn.
`{ signal }` aborts a video: its output is aborted and its views are given back.

For manual control, call `await video.frame([view])` one frame at a time, then
`await video.finish()`. Finish and abort are idempotent; both release the output's writer lock,
encoder, and abort listener. Frame/time counters remain readable after completion. A failed
step, frame, write, or progress callback aborts `record`. Cancellation interrupts pending rendering
and encoding; an arbitrary writable sink must still settle its own in-flight write before its
lock can be released. Browser output uses Constrained Baseline H.264, with output timestamps
checked against input order.
