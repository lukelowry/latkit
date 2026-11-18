---
'latkit': minor
---

A history can be written as time tiles while it is recorded, with the levels of detail latkit builds, in memory that stays the same however long it grows.

- Added: `TileWriter`, which applies patches of appends to the tables of a base dataset and writes each span as it fills. `flush` writes the spans in progress, the base, and `frames.json`, so `Tiles` drawing them find every frame so far. Its files are the ones `latkit tile` writes for the same frames.
- Added: in Rust, `TileWriter`.
