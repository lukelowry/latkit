---
'latkit': minor
---

Edges joining the same two vertices run side by side, a few pixels apart at any zoom, instead of bowing apart. The theme sets their spacing and how they meet their vertices.

- Added: `theme.edge.parallel`, with `gap`, the space between neighboring edges in CSS pixels (defaults to 3), and `converge`, how they meet the vertices they join: `squeeze` (the default) draws them closer so the family fits within the smaller vertex, `fan` keeps their spacing and angles them in to each vertex's center, and `straight` keeps their spacing and stops each at its vertex's outline, or beside it. `null` draws them over one another. Rust: `EdgeTheme::parallel`, `Parallel`, and `Converge`.
- Removed: `theme.edge.bow`. Use `parallel`, or `parallel: null` where `bow` was 0.
- Changed: parallel edges are each moved sideways on screen by a step, an edge's width plus `gap`, so they look the same on a plane, tilted, and on the globe, and stay apart when zoomed out. Edges that bend through the same points, and edges along great circles, now run side by side too. More than eight edges pack within eight steps, and edges less than a pixel apart draw only every second one, or fewer.
- Changed: a straight edge with parallel neighbors draws as one segment instead of sixteen, or three where it fans. Only fans and great circles need a segment list, and moving the camera never rebuilds it.
