---
'@latkit/network': patch
---

An edge ends at the rim of its endpoint discs instead of running under them, so a vertex always covers its own edges while true depth orders every other overlap. The edge shader discards fragments inside the disc the vertex pass draws, in every projection.

- Changed: edges and focused edges write depth; halos, borders, and the earth axis only test it. Items of one kind share one depth bias, so overlapping edges or discs blend in draw order instead of cutting each other's anti-aliased fringe.
