---
'latkit': minor
---

A recording plays along as its frames arrive, and keeps on the GPU only the frames it holds.

- Added: `playhead.live` (Rust: `Playhead::set_live`). The playhead plays along the end of its span as the page extends it with arriving data, trailing the end at the rate the end moves, so data that arrives in uneven chunks plays at an even pace. It eases to a stop when no more arrives.
- Fixed: frames a dataset forgot stayed cached on the GPU until the page pool reached its budget, 1 GiB by default. They are now freed, so a recording keeps only what it holds.
- Fixed: after `forget`, `describe().span` could start a coarse bucket before the first frame kept, and move back as buckets filled. It now starts at the first frame kept.
- Fixed: a time tiles index not there yet, as before a recording's first frames, failed as "not TileJSON". It now fails as not found, and is fetched again after its retry.
