---
'latkit': minor
---

A flat map is one world, and every camera move keeps within the camera's reach.

- Changed: a flat map's ground ends at the antimeridian, as it ends at Web Mercator's latitude limit. Its camera zooms out only until the whole world fits inside the insets, and pans only until the world's edges meet the view's. A globe's camera zooms out until the globe spans a third of the view's shorter side.
- Changed: setting the camera, flights, fits, orbits, and every gesture keep the camera within reach, which fits narrow to what they framed, and its pitch within 75°. When a resize, new insets, or a new space moves the camera back within reach, a `camera` event reports it.
- Changed: a flight on a flat map eases across the world instead of the short way over the antimeridian; on a globe, longitude still turns the short way.
- Fixed: panning a flat map no longer wraps its center across the antimeridian, which moved every row a world away.
- Fixed: a scene with another kind of space drops the old space's fits and the camera motion under way.
