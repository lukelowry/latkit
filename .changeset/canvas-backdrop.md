---
'latkit': patch
---

A canvas shows its views' backgrounds from the moment it is made, never black, and keeps its last frame when the GPU is lost.

- Fixed: a canvas showed black until its views' shaders compiled, about half a second on a large scene. It now shows each view's background from the same task that makes it, as frames show until a fit places the camera. Resizing it before its first frame shows the backdrop too.
- Fixed: on a canvas with several views, a view that had not drawn yet showed black in its panel. It shows its background until it draws.
- Fixed: gaps between a canvas's panels showed black, or what an earlier layout drew there. They show the first view's background, as gaps in a picture do.
- Fixed: after the GPU was lost, a canvas started over while its views compiled again. It keeps its last frame, its focus, and the pointers it holds.
- Fixed: while its views' shaders compiled, a new canvas asked for a frame on every animation frame. It now waits for each compile to land.
- Added: in Rust, `Canvas::move_to`, which moves a canvas to a new `Gpu` as `PageView::move_to` moves a view.
