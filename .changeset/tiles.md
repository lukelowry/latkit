---
'latkit': minor
---

A vector tile costs only the rows it brings, and the tiles drawn largest split first.

- Changed: an arriving vector tile appends its rows, so rows already drawn do not upload or evaluate again.
- Changed: a tile that stops drawing keeps its rows and draws them again if it comes back. Once rows that no tile draws outnumber the drawn rows by a page, they are all removed. Until then, `view.snapshot(name)` of a vector source includes them.
- Changed: tiles split by the area they cover on screen, so tiles near the globe's edge and a tilted map's horizon stay coarse.
- Changed: when the tile budget runs out, the tiles drawn largest split first, for vector tiles and paged tables alike.
- Changed: at most 128 vector tiles draw at once.
- Changed: a vector table draws each tile's rows in the order of the mark's `priority`, highest on top.
- Fixed: a flat map no longer fetches tiles past the antimeridian as if they were near.
- Fixed: two tiles arriving together with different kinds for the same field no longer fail every update.
