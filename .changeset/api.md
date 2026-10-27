---
'latkit': minor
---

A view takes one call, a mark names its table with its kind, and a dataset writes itself.

- Added: `View.create(canvas, scene, { region, camera, sources, gpu, pixelRatio })` shows a view on a `<canvas>` or `OffscreenCanvas`, over the views already there, or with a `null` canvas draws only into pictures. Views share the first `Gpu` created, which `View.create` creates when there is none; `view.region` moves a view and `view.gpu` is its GPU.
- Added: `data.table(name)` and `tiles.table(name)` give a `Table`, which a mark draws and `field(name).from(table)` reads. A view draws the datasets its scene's tables belong to, so `sources` lists only the datasets named by `[data, table]`.
- Added: every `Patch` change is also a `Data` method that applies at once: `axis`, `replace`, `set`, `remove`, `append`, `forget`, `frames`.
- Added: `Shot.of(view, options)` pictures what a view's canvas shows; `new Shot(size, { views })` draws views in their regions, or `{ view, region }` in another.
- Changed: a mark's kind key holds its table, beside its options: `{ vertices: grid.table('Bus'), radius: 4 }` (in JSON, `{ "vertices": ["grid", "Bus"], … }`) replaces `{ vertices: { of: ['grid', 'Bus'], radius: 4 } }`. Errors name the option's path, as `marks[1].radius`.
- Changed: `replace` and `set` given fields alone write rows `0` to `n - 1`.
- Removed: `gpu.view`, `gpu.canvas`, `Canvas`, `canvas.layout`, `canvas.shot()`, the `Panel` type, and the shot's `layout` option.
