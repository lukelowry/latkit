---
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
'@latkit/video': patch
'@latkit/model': patch
---

Exports never change a view, item views check every option the same way, and views stop cleanly with their Gpu.

Added

- `gpu.signal`: aborts when the Gpu stops, with `device-lost` or `closed`.
- `FrameInfo.presented` and `RenderView.presented`: video, and images of a view on a canvas or in a composition, render frames that are not presented.
- `kit.ItemShape`: an item view describes its framed camera keys, input modes, and style defaults once.

Changed

- Video, and images of a view on a canvas or in a composition, draw the view as it is and change nothing: its camera, hover, selection, and picking stay as presented. A monitor draws them into history of its own. A view with neither presents in its images.
- Unknown camera and input options, and input modes a view does not have, throw `invalid-input` in every view, and the patch changes nothing.
- A mode shorthand merges like the option it names: `set({ input: 'inspect' })` keeps `wheel` and `keyboard`.
- The `frame` event reports the frame's `FrameInfo` and nothing it borrowed.
- A right click opens the context menu where the button comes up; a right drag never opens it.
- Views stop drawing when their Gpu stops: device loss reports one `device-lost` error per view, and destroying the Gpu reports none. The Gpu no longer keeps destroyed views alive.
- `image()` and `exportVideo` wait for a canvas frame that cannot stop at once, instead of failing `busy`.
- `view.config` is typed without `camera`, which lives on `view.camera`.
- `kit.BaseItemView` takes `(gpu, config, shape)`; `compileShade` receives the `msaa` to compile for; `kit.BaseView`'s `moveCamera` hook is `cameraMove`, which validates before a patch applies.
- Network: `pick`, clicks, and context menus wait for the background hit-test index, starting it at once, instead of building it on the main thread.
- Video: an export ends with the Gpu's `device-lost` error.
- Model: `sliceColumn` returns exactly its kind's keys, so a point read of a sampled field is a plain column however its pages lie; `selectRows` encodes each requested ID into one reused buffer.

Removed

- `Gpu.lost`; use `gpu.signal`.
- `kit.BaseItemView`'s `framed` and `inputMode` members; use `kit.ItemShape`.
