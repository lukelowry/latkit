---
'@latkit/gpu': minor
'@latkit/diagram': minor
---

A diagram lays out, packs, and routes each connected part on its own, so a case of many separate parts reads as a grid of them; motion is drawn on the GPU at any size; and `set` keeps what a patch repeats.

Added

- diagram: `aspect` in `LayoutOptions`, the shape of the rows parts pack into; `LayoutEdge` and `LayoutPort`, with a port's `offset` from its vertex and an edge's `labelRoom`, the room its labels take between its ends.
- gpu: `replace` in `SetOptions`: the patch is the whole config, and what it leaves out resets.

Changed

- diagram: vertices that edges join form a part. Each part is arranged alone, and the parts nothing pins pack into rows below the pinned ones; a group is arranged inside first and then moves as one vertex of its part. The 2,000-bus Texas case routes in 0.16 s rather than 1.4 s, its wires a 26th as long; 10,000 buses route in 0.46 s rather than 27 s.
- diagram: a `LayoutStrategy` arranges one part at a time, and its vertices are vertex rows or groups, named by `item`. Every vertex the layout places moves by whole grid steps, a strategy's included.
- diagram: a vertex with `x` and `y` is always pinned, and the layout places only the rest. Positions are read apart from the structure, so new positions alone reread nothing else: accepting a move at 10,000 blocks takes about half as long.
- diagram: a move proposal's `positions` hold each dragged vertex and each the layout placed, so writing them keeps the drawing as shown.
- diagram: transitions ease vertices on the GPU and fade wires between their routes, at any size, so no frame reroutes; picking holds the target, as it holds accepted positions during a drag.
- diagram: a part that did not change keeps its wires and labels, and edges keep their routes by row identity, so a row read earlier no longer routes every later one again.
- diagram: labels slide along their wire to a spot clear of blocks and group titles, and the layout leaves room for a tag's label at each end.
- gpu: a patch value equal to the one held keeps the held one, so a view rebuilds nothing from it, and a patch that changes nothing does nothing, `animate` included. Plain objects compare by what they hold; data under a `source` compares as itself.

Removed

- diagram: `'manual'` layout, now that positions pin; the `layout` string shorthand and the `Layout` type; `MoveProposal.moves`; `LayoutGraph.pairs` and `groups`; `animationMaxVertices`.
- gpu: `ConfigShape.shorthands`.
