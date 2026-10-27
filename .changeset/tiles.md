---
'latkit': minor
---

A vector tile costs the rows it brings, and tiles split where they draw largest.

- Changed: a vector tile landing appends its rows, so rows already drawn neither upload nor evaluate again. A tile that stops drawing keeps its rows and draws them again if it returns; once rows no tile draws outnumber the drawn rows by a page, they are removed at once. Until then `view.snapshot(name)` of a vector source includes them.
- Changed: a tile measures the area it covers on screen, so tiles toward the globe's edge and a tilted map's horizon stay coarse. When the tile budget binds, the tiles drawn largest split first, for vector tiles and paged tables alike. At most 128 vector tiles draw at once.
- Changed: a vector table draws each tile's rows in the order of the mark's `priority`, highest on top.
- Fixed: tiles past the antimeridian of a flat map are no longer fetched as if near.
- Fixed: two tiles landing together whose field reads as different kinds no longer fail every update.
