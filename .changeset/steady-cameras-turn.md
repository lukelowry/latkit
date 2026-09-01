---
'@latkit/network': minor
'@latkit/embed': minor
---

Unify flat, tilt, and globe navigation around a transferable camera pose; expose the active projection plus `getPose()` and `setPose()`, support pitch and bearing on the globe, and rename the public shader grouping type to `ProjectionFamily`. Apply shared solar-terminator daylight rendering across geographic projections, consolidate projection pipelines and picking math by family, and forward pose controls through `NetworkElement` and the standalone embed.
