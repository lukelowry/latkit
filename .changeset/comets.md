---
'latkit': minor
---

Comets keep their spacing on screen, cost little while only they move, rest while the camera moves, and keep clear of arrowheads.

- Fixed: comets and dashes in CSS pixels bunched on fanned edges and spread out on north–south edges away from the equator. They keep the theme's spacing on screen along every path, through fans, on a flat map, a tilted one, and the globe.
- Fixed: comets covered the arrowheads of short or bent edges. They fade out before the head, and a stub too short for one carries none.
- Changed: comets move without a pass over their rows each frame.
- Changed: frames where only comets moved, one after another, draw them over a kept image of what lies under them, so the rest draws only when something changes. A lone such frame between changes draws whole.
- Changed: while the camera moves by a gesture, a flight, a fit, or a camera set from code, comets fade out and hold still, and they fade back in once it rests for 0.15 s. Orbits, pictures, videos, and reduced motion keep them moving.
- Changed: a comet with less than 3:1 contrast to its stroke takes a 1-pixel rim of the background color.
- Added: `controls.fps` (Rust: `Controls::fps`), the most frames a second a canvas draws while only endless motion moves: comets, an orbit, or options that read `elapsed()`. Defaults to 60.
