---
'latkit': minor
---

A recording plays along as its frames arrive, and keeps on the GPU and in memory only the frames it holds.

- Added: `playhead.live` (Rust: `Playhead::set_live`). The playhead plays along the end of its span as the page extends it with arriving data, trailing the end at the rate the end moves, so data that arrives in uneven chunks plays at an even pace. It eases to a stop when no more arrives.
- Fixed: frames a dataset forgot stayed cached on the GPU until the page pool reached its budget, 1 GiB by default. They are now freed, so a recording keeps only what it holds.
- Fixed: after `forget`, up to 16 pages of each row block and level of detail stayed in memory per sampled field, so a rolling window of a large recording grew memory far past the frames it kept. Forgotten frames are now freed once no version reads them.
- Changed: a table drawn in priority order or by tiles reads sampled fields on the GPU through its rows, as any other table does. Showing another frame no longer gathers each row's value on the CPU, which took about 40 ms a frame for 165,000 rows.
- Changed: appending frames opens each page of a row block's frames at its full size, so it fills without moving.
- Fixed: after `forget`, `describe().span` could start a coarse bucket before the first frame kept, and move back as buckets filled. It now starts at the first frame kept.
- Fixed: a time tiles index not there yet, as before a recording's first frames, failed as "not TileJSON". It now fails as not found, and is fetched again after its retry.
- Fixed: Chrome warned "READ-usage buffer was written, then fenced, but written again before being read back" while labels settled or the pointer moved. A readback buffer now gets new storage at its next write rather than after each read, which also spares the browser a copy of it.
