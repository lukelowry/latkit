---
'latkit': minor
---

Histories fetched in spans, and a frame's work follows what changed.

- Added: time tiles. `view.setTiles(name, url)` opens a `frames.json` manifest, as `latkit tile` writes it, and fetches the spans of each sampled field's history its lines draw, at the detail they draw; a span still loading draws the coarser one above it.
- Added: `Patch.frames(table, field, { level, first }, at, values)`, a run of a sampled field's entries, as a time tile holds them.
- Changed: errors reading JSON (scenes, cameras, fits, queries, rows, budgets, shots) name the path to what could not be read, such as `scene.marks[2].color`.
- Changed: a patch evaluates only the pages it wrote; a transition evaluates once and blends each frame; rows drawn through tiles keep their places while the camera moves, so only arriving rows upload; the views of a `Gpu` share its budget, none planning past it together.
