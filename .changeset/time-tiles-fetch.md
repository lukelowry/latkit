---
'latkit': patch
---

Time tiles fetched through the app work, and a live run's `refresh()` fetches only what changed.

- Fixed: `Tiles` with a `fetch` no longer stops latkit on their first file. latkit calls `fetch` after the frame that needs the file, so it may change views and datasets.
- Fixed: tiles at one URL with different `fetch` functions each draw their own files. Before, every view drew the files of the first.
- Fixed: a manifest whose `url` lacks `{level}` or `{index}`, or `{field}` when it lists several fields, is invalid. Before, its spans shared files and drew each other's entries.
- Changed: `tiles.refresh()` keeps the base dataset and the spans the earlier frames filled. It fetches the last span of each level again, which draws what it held until the new one arrives, and every span that failed. Before, it fetched the base again and redrew every span. A manifest that names another base, `chunk`, or `url` starts over.
- Changed: a span that could not be fetched is fetched again on the next refresh, and each tile failure is reported once.
- Changed: a trace whose plot window needs more than 64 spans draws from a coarser level, rather than its middle at the finer level between coarse placeholders, which broke the line.
