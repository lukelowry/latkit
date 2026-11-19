---
'latkit': patch
---

Tile refreshes and failures keep their state, traces take scaled fields, plots keep a least range, and comets, dashes, and playback cost only what changes on screen.

- Fixed: a tile refresh dropped the fetches under way, so refreshes faster than a fetch never landed. A file being fetched now lands, then is fetched once more however often the tiles were refreshed meanwhile, and the index is fetched one at a time the same way.
- Changed: a tile source that fails to fetch is listed in `view.failures` (Rust: `View::failures`) until it is fetched, so `failures` events tell both when it fails and when it recovers. It is no longer an `error` event.
- Added: `lines.trace` (Rust: `Lines::trace`) takes an expression that multiplies a sampled field by a number and adds one, such as `{ "mul": ["$vm", 100] }`, as well as a field's name. The line, its hits' sample values, and the plot's fit use the value drawn. Rust: `Trace`.
- Added: `minSpan` on a plot axis (Rust: `Axis::min_span`), the least range a fit shows, centered on what it fits, so a steady signal draws flat instead of filling the plot with its noise.
- Fixed: `controls.fps` did not cap playback. Frames where only the shown coordinate moves, as a playhead plays, now draw at most that many times a second.
- Changed: on a plane seen straight down, dashes and comets measure distances along paths in position units once and scale them, so zooming and panning measure nothing again.
- Changed: comets on recorded strokes draw a quad for each comet that their segments' parts on screen can carry, so zoomed in, comets on long segments cost the pixels the comets cover, and segments off screen cost nothing.
- Changed: the `wgsl` marker's docs say its color's alpha is the pixel's coverage, which latkit blends as given, so the marker fades its own edge.
