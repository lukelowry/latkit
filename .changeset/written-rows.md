---
'latkit': patch
---

A write uploads only the rows it changed, and a field written every frame no longer grows GPU memory.

- Changed: a row written into a table drawn whole uploads its own values into the page the GPU already holds. Before, the whole page of 4,096 rows uploaded into newly allocated memory. `gpu.work.uploaded` counts the rows written, 16 bytes for one.
- Changed: a version of a page that no view draws any more is freed at once. Before, it stayed cached, so writing a field every frame grew GPU memory to the budget. A view drawing a `Snapshot` keeps the pages of its version, and `Data.restore` uploads the pages it brings back.
- Changed: `f32` values upload as stored, without conversion.
