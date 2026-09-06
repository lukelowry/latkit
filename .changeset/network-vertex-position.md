---
'@latkit/network': minor
'@latkit/embed': patch
---

Vertex placement is a channel. `vertexPosition` holds interleaved `x, y` pairs in topology coordinates, the shape `vertexCoords` has; `load` seeds it from the topology, and rebinding it moves vertices, the ends of their edges, and their height poles at the cost of one upload, with no reload and no allocation, so a layout engine can hand over its array every frame.

- Added: the `vertexPosition` channel, raw and always bound while a topology is loaded; `null` restores the topology's own layout. `CHANNELS` entries carry `components`, `2` for position and `1` for every scalar channel, and a channel's length is `count * components`. `fit()` frames the positions in effect. The `vertex-position` attribute on `latkit-network` binds a vertex field of `vertexCount * 2` values.
- Changed: the plane shaders read vertex placement from the position channel, the edge ends follow the endpoint vertices, and polyline bends keep the coordinates the topology baked; the picker indexes the position snapshot and rebuilds its index only once positions have held still, so while positions change from one frame to the next hover clears and `hitTest` finds nothing, resuming one frame after the last write; the globe draws the layout the topology carries, so `projections.globe` is false while positions override it and binding positions on the globe falls back to flat; the uniform block grows to 464 bytes.
