---
'latkit': minor
---

Strokes carry markers along their paths, such as a breaker's square or a transformer's symbol. Arrowheads are gone: comets show which way a row flows.

- Added: `markers` on edges and lines, at most four, each a shape, an icon, or a symbol at a place along each row's path: `{ marker, at, offset, size, color, visible }`, or a shape's name alone. `at` runs from 0 at the path's start to 1 at its end. A marker lies wholly on one segment, so it slides clear of a bend. The stroke stops at each marker's box and goes on after it, and comets pass under it. Rust: `StrokeMarker`, `Edges::markers`, `Lines::markers`.
- Added: `blend` on edges and lines says where along its path a row's color goes from its first to its second: a fraction for a sharp change there, or `[from, to]` to blend between two places. An edge with no color of its own takes the colors of its ends, so a branch can show each side of a transformer in its own bus's color. Rust: `Edges::blend`, `Lines::blend`.
- Added: a label's `offset` takes a value for each row, in pixels or `{ units }`.
- Changed: `controls.motion` defaults to `full`. A view animates whatever the system prefers, and `motion: 'system'` follows the system's reduced-motion setting, as the default did.
- Changed: `theme.text.halo`, `theme.edge.halo`, `theme.line.halo`, and `theme.flow.width` take `{ units }` as well as pixels. With `flow.width` in units, comets zoom with the drawing whole.
- Changed: comets sized in position units rest once their tails are under two pixels long, and the view asks for no frames for them.
- Changed: a fit frames a marker's box as its bearing turns it, the margin a symbol's ink may reach, and beside a stroke, half its width, its halo, and its markers.
- Changed: every stroke draws with one program whatever path it follows, so a scene of edges and lines compiles one program fewer.
- Changed: the npm package packs the variants of each shader function together. Its shaders take about 40 kB less, and the main module is 3.72 MB with markers and blends included.
- Removed: `arrows` on edges and `theme.edge.arrow`. Give rows a `flow` to show their direction.
- Rust: `Label::offset` takes a `Size` for each side. `TextTheme::halo`, `EdgeTheme::halo`, `LineTheme::halo`, and `FlowTheme::width` are a `Length`. `Motion` defaults to `Full`. `EdgeTheme` lost `arrow`, so build it from its default.
