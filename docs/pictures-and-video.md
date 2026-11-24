# Export images and video

A [`Shot`](reference/api.md#shot) draws one or more views into an image of the requested
size, even if the views have no canvas. Use `Shot.of(view)` to capture an existing canvas at
its current size.

```ts
const shot = new Shot([3840, 2160], { scale: 2, views: [view] }); // 1920 by 1080 CSS pixels
const image = await shot.image(); // once the view is complete and still
const png = await image.encode('png'); // or 'jpeg' with { quality }, or 'webp'
image.destroy();
```

## Video

`shot.video({ fps, output })` writes an H.264 MP4 to a `WritableStream` using WebCodecs.
Frame `n` uses video time `n / fps`. If nothing moves, the encoder repeats the preceding frame.
`record(step)` calls `step(time)` before each frame and finishes when it returns `false`.

```ts
const file = await (await showSaveFilePicker()).createWritable();
const video = new Shot([1920, 1080], { views: [view] }).video({ fps: 60, output: file });
await video.record((time) => {
  view.at = time;
  return time < 10;
});
```

To draw frames one at a time, call `video.frame()` for each frame and `video.finish()` at the end,
or `video.abort()` to stop.
