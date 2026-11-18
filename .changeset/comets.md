---
'latkit': minor
---

Comets keep their spacing on screen along every path, and a view whose only motion is comets draws them without drawing everything again.

- Fixed: comets and dashes in CSS pixels bunched up on edges that fan into their vertices, and spread out on edges running north and south away from the equator, twice as far apart at 60°. They now keep the theme's spacing on screen along straight edges, great circles, bends, and fans, on a flat map, a tilted one, and the globe.
- Fixed: comets on an edge that fans continue through its fans, in position units too, instead of crowding where the fans meet the edge.
- Changed: comets move without a pass over their rows each frame. Their rows' travel is written only when their flow changes, their rows move, and once a minute.
- Changed: a mark's comets draw after its rows, over its own lines and wherever nothing nearer was drawn. While comets move, a view keeps an image of what it draws before the first mark's comets, and a frame where only comets moved starts from it: the backdrop, the marks under the comets, and their lines draw only when something changes. This holds on a flat map, a tilted one, and the globe.
- Changed: a comet whose color contrasts less than 3:1 with its stroke takes a 1-pixel rim of the background color ahead of its head, so it shows on light strokes.
- Added: `controls.fps`, the most frames a second a view in a canvas draws while the only thing moving is motion that never settles: comets, an orbit, and options that read `elapsed()`. Any other change draws on the next display frame. Defaults to 60. Rust: `Controls::fps`.
