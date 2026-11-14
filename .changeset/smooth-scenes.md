---
'latkit': minor
---

A view keeps drawing while a new scene's pipelines compile, and draws in depth order with half the compiles.

- Changed: a scene set while the view draws another draws once the pipelines its frames draw with have compiled. Until then the view goes on drawing, and answering for, the scene before, so changing the space, a projection, or a mark no longer stops the view for a compile. Fits and cameras asked for meanwhile apply to the new scene, and `scene` returns it. A scene set before the view's first frame compiles after the first one, so it draws second.
- Changed: where depth varies, a mark's opaque pixels draw with the same program as its other pixels, through a copy of its uniform. Each point and stroke draw compiles once instead of twice, so a tilted or globe view draws in depth order from its first frame. Height sorts are the only pipelines left that a view asks for once depth varies.
