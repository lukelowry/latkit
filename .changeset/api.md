---
'latkit': minor
---

`View.create` opens a view in one call, a mark's kind key holds its table, and `Data` applies changes directly.

- Added: `View.create(canvas, scene, { region, camera, sources, gpu, pixelRatio })` draws a view on a `<canvas>` or `OffscreenCanvas`, over any views already there. With a `null` canvas, the view draws only into pictures.
- Added: views share the first `Gpu` created, and `View.create` creates one if there is none. `view.region` moves a view, and `view.gpu` is its GPU.
- Added: `data.table(name)` and `tiles.table(name)` return a `Table` for a mark to draw or `field(name).from(table)` to read. A view loads every dataset its scene's tables belong to, so `sources` lists only datasets named as `[data, table]`.
- Added: a `Data` method for every `Patch` change, applied immediately: `axis`, `replace`, `set`, `remove`, `append`, `forget`, `frames`.
- Added: `Shot.of(view, options)` captures what a view's canvas shows. `new Shot(size, { views })` draws views in their own regions, or in another region given as `{ view, region }`.
- Changed: a mark's kind key holds its table, next to its options: `{ vertices: grid.table('Bus'), radius: 4 }`, or `{ "vertices": ["grid", "Bus"], … }` in JSON. This replaces `{ vertices: { of: ['grid', 'Bus'], radius: 4 } }`.
- Changed: errors name the option's path, such as `marks[1].radius`.
- Changed: `replace` and `set` given only fields write rows `0` to `n - 1`.
- Removed: `gpu.view`, `gpu.canvas`, `Canvas` (with `canvas.show(views)` and its `panels`), and the `Panel` type.
