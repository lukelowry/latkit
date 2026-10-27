---
'latkit': minor
---

A flat map shows one world, and every camera move stays within the camera's zoom and pan limits.

- Changed: a flat map's ground ends at the antimeridian, as it ends at Web Mercator's latitude limit.
- Changed: on a flat map, the camera zooms out only until the whole world fits inside the insets, and pans only until the world's edges meet the view's edges.
- Changed: on a globe, the camera zooms out until the globe spans a third of the view's shorter side.
- Changed: setting the camera, flights, fits, orbits, and gestures keep the camera within its zoom and pan limits, and its pitch within 75°. After a fit, the limits narrow to the area the fit framed.
- Changed: a `camera` event fires when a resize, new insets, or a new space moves the camera back within its limits.
- Changed: on a flat map, a flight eases across the world instead of the short way over the antimeridian. On a globe, longitude still turns the short way.
- Fixed: panning a flat map no longer wraps its center across the antimeridian, which moved every row a world away.
- Fixed: a scene with another kind of space drops the old space's fits and any camera motion in progress.
