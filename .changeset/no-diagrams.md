---
'latkit': minor
---

The diagram space is gone. Graphs draw on a plane or the earth, a plain length is CSS pixels everywhere, and the wasm is about 8% smaller. Laid-out graphs open faster, and dragging their rows costs only the rows that move.

- Removed: the `diagram` space and its theme group: `Diagram`, `DiagramTheme`, and `ShadowTheme`.
- Removed: vertex `ports`, `contains`, and `shadow`, with `Port` and `Side`. Edges without `ends` are no longer nets, and the `orthogonal` route is gone, so `Route` is `straight` or `geodesic`.
- Removed: grid `snap`, the theme's `edge.spacing`, `px()`, and the `{ px }` form of sizes and lengths. A plain number is already CSS pixels.
- Removed: `Hit.port`, `End.port`, and the `port` option of `view.screenOf`. In Rust, `View::screen_of(row)` takes only the row, and `Host::measure` is gone.
- Changed: the block marker's corner defaults to the theme's new `vertex.corner`.
- Changed: with a layout, a vertex mark draws each row at its data's position and takes the layout's place only where the data gives none. Editing positions, as a drag does every frame, no longer rebuilds every row's place: only the rows written are checked for a lost position. Nets' stars recompute only when their members, the members' positions, or the layout's places change.
- Changed: a layout small enough for the frame runs on it rather than in a host job, and a stress layout stops once it settles. Layouts place points, so they no longer size, nest, or pad rows, and a layout job carries a third of the bytes per row.
- Fixed: layouts and `view.neighbors` now follow nets drawn with `joins`. Each net links its first member to every other.
