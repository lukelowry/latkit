---
'latkit': minor
---

A table too large to draw whole draws pages of its order, which keep their place on the GPU as the camera moves: coming back where the camera was packs, uploads, and evaluates nothing, and what the view derives follows the data, never the camera.

- Added: `Gpu.resident` and `Gpu.uploading` (`Gpu::resident()` and `Gpu::uploading()`): bytes of data on the GPU, and waiting to upload, for every view of it.
- Added: `Work.packed`, the rows packed into pages of the order a table drawn in part draws in: each page once, the first time a view draws it, and again only where a write changed its rows.
- Removed: `Stats.uploading`, `Stats.resident`, and `Stats.budget`; read them from the GPU (`gpu.uploading`, `gpu.resident`, `gpu.budget`).
- Changed: a table drawn in part holds whole pages of its order, each in a place of its own, and a page it no longer draws stays held while the plan leaves room, so drawing it again costs nothing.
- Changed: appending to a table drawn through tiles no longer thins it, and costs a page: rows appended draw after the rows its tiles were made from, which are made again once rows appended since are an eighth as many, or a row before them changes.
- Changed: lanes, the stars of nets, joins, and fitted domains read the data, not the rows drawn: they no longer change as the camera moves, and a fitted domain spans every row of its table. Areas drawn in part are triangulated a page at a time, the first time the page draws.
- Changed: a vertex shows from as far out as the most important edge ending at it, so an edge drawn always shows with its ends; until tiles land, the first look at a table draws the vertices its edges sampled end at first.
- Changed: a hit names the row and the place the frame it answers drew, however the data, the scene, or the camera changed before it landed.
- Changed: a GPU's views draw one frame together: `Budget.uploadPerFrame` bounds what all of them upload in it, and jobs go to a worker only as one frees, those nothing waits for any more dropped first.
- Changed: a GPU decides its antialiasing once, from the screen it serves, so a browser zoom compiles nothing.
- Changed: zooming at the limit a fit sets keeps the center where it was.
- Fixed: on a flat map, a table drawn through tiles draws alike at every latitude, where a band of tiles drew finer than the rest; vector tiles split alike too.
