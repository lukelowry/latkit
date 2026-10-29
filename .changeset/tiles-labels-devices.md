---
'latkit': minor
---

Tiles fetch through the app and refresh, labels write numbers, options that do not fit draw as if unset, and views survive a lost device.

- Added: `new Tiles(name, url, { fetch })` fetches the tiles' files through the app, and `tiles.refresh()` fetches the index again, keeping the time spans the earlier frames cover. `Tiles` documents the time tile manifest.
- Added: number labels, written on the GPU each frame: `label: { text: field('vm'), precision: 3, unit: ' pu' }`, with an axis's `format`.
- Added: `domain('all')` maps every value a field holds, in every frame of a sampled field.
- Added: `expr.fallback(other)`, and `meters(length)` for lengths on the earth.
- Added: `view.fit()` resolves to the camera it framed, or `null` when replaced. `fit({ tables })` frames whole tables. A reveal asked while a fit is due follows it.
- Added: `view.done()`, which resolves once the view is complete.
- Added: `view.arrange('all')` lays out every row, positions given or not.
- Added: a `drag` event's `patch` writes the dragged row's new place.
- Added: `controls.scrub`: clicking or dragging across a plot moves `at`, emitting an `at` event.
- Added: `view.screenOf(row, { port })`.
- Added: `theme.contrast`, the least WCAG contrast that colormap colors keep with the background.
- Added: `patch.byteLength`, and `signal` on `Gpu.create` and `View.create`.
- Added: when the device is lost, latkit requests a new one and moves the views, canvases, and frame listeners to it with their state. In Rust, `View::rebuilt(gpu)`.
- Changed: an option that does not fit the data draws as if unset and is listed in `failures`, instead of failing the mark. A label whose text does not fit shows none.
- Changed: `view.camera`, `fly`, and `View.create`'s `camera` take a partial camera. A pitch or bearing alone turns the camera and keeps a fit due.
- Changed: writing values a table already holds changes nothing, so nothing evaluates again. `replace` with the same ids writes over the table like `set`.
- Changed: `frames()` may write a level's last entries again, as a bucket fills.
- Changed: an edge without a color blends its ends' colors per row, also where its own color is missing.
- Changed: `colormaps()` returns each map's colors and needs no WebAssembly.
- Changed: `load({ worker })` takes the worker asset's URL. One on another origin starts through a Blob URL.
- Changed: a plot's grid lines draw under its marks.
- Changed: a fit of markers sized in units frames the same from any zoom.
- Changed: `complete` is false until a frame draws the view, and `View.create` compiles its scene against its sources, so the first frame reports no failures the data resolves.
- Changed: points and strokes write depth only where opaque, so their edges no longer shimmer.
- Changed: an empty table takes the id kind of its first ids, and NaN in a reference's `Float64Array` names no row.
- Changed: JSON errors no longer end in " at line N column M".
