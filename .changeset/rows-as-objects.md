---
'latkit': minor
---

Rows draw as objects: symbol markers, edges that meet a bar where they are drawn to, labels with a place, halos that part crossing strokes, categories by value, and pictures sized by their drawing. A mark's shaders hold the code of `meet`, `bearing`, a label's `place` and `offset`, and a halo only when the mark uses them, so other scenes compile and draw as before.

- Added: `marker: { symbol: { paths, index, stroke } }` draws SVG path data, filled or stroked, and `marker: 'none'` draws only a row's label. npm: `symbol(paths, options)`. Rust: `Marker::symbol`, `Marker::stroke`, `Marker::None`.
- Added: `bearing` on vertices turns each row's marker, in degrees clockwise from up. Rust: `Vertices::bearing`.
- Added: `meet: 'nearest'` on edges lands each end on the point of its vertex's marker nearest the path, so edges drawn to a bar or a wide block land square on it. Rust: `Edges::meet`, `Meet`.
- Added: a label's `place`, a side or corner or a text field that names one for each row, and its `offset`. A label's `size` takes `{ units }`. Rust: `Label::place`, `Label::place_by`, `Label::offset`.
- Added: `theme.edge.halo` and `theme.line.halo`, a band of the background's color beside each stroke, which parts the strokes drawn under it.
- Added: `values` on a categorical colormap, a number or a text for each category, and the `match` expression. npm: `Expr.match`. Rust: `Colormap::values`, `Expr::matched`, `Category`.
- Added: `plane: { y: 'down' }`, for positions drafted on a screen or a page. Rust: `Plane::y`, `Vertical`.
- Added: `latkit render --size 1920x` or `--size x1080`. The side left out follows what the scene's fit frames. Rust: `View::bounds`.
- Changed: a legend of categories draws each as its mark draws rows, a stroke at its width or a marker's shape, and sets them in one row above or below the marks.
- Changed: `theme.edge.parallel.gap` takes `{ units }` as well as pixels. Rust: `Parallel::gap` is a `Length`.
- Changed: a conditional compiles with any number of cases. A long chain was refused as too deep.
- Changed: each translated shader function numbers its own names the same way in every shader, so the npm package keeps it once. Its shaders take about 60 kB less with the new ones included, and the main module stays at 3.71 MB.
- Fixed: a fit frames the bends of edges, which can lie outside the box of their vertices.
- Rust: `Label::size` takes a `Length`. `Plane`, `EdgeTheme`, and `LineTheme` gained a field, so build them from their defaults.
