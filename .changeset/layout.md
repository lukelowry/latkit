---
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/diagram': minor
---

Every view places vertices without a position through one layout: a network spreads them among the vertices they join, where it drew them on a circle, and a diagram ranks them as before.

Added

- gpu: `LayoutOptions`, `LayoutStrategy`, `LayoutPart`, `LayoutItem`, and `Positions`, shared by the views; `kit.Graph`, `kit.place`, and `kit.layoutOptions`, which place a graph's vertices part by part; `kit.channelValues`, a channel's value at every row of a fields block in one pass.
- gpu: the `'stress'` layout, which keeps each part's graph distances, an edge `vertexGap` long, with pinned vertices fixed. It is linear in the part: a 100,000-bus network without positions draws its first frame in under half a second.
- network: `layout` in the config, `layoutMs` in `limits`, and `arrange`, which places a network's vertices without drawing: positions by vertex type.

Changed

- network: a type without `x` or `y`, and each row whose position reads no number, is placed by `'stress'` among the positioned vertices it joins, each edge as long as theirs; parts nothing positions pack below. Geographic data may hold such rows. Placed vertices stay where they were as the data changes, until the layout options do, and a network that positions every vertex reads nothing more.
- diagram: a `LayoutStrategy` arranges a `LayoutPart`: its vertices and edges by index into a graph, with columns of pins, sizes, end directions, ports, and label room. It returns two numbers a vertex.
- diagram: in a group, flow runs from the outputs inside it, so a net whose source is outside orders its other ends only by their own directions.
- diagram: layout takes about a tenth less time, and `neighborhood` and drags read each vertex's own edges rather than every edge.

Removed

- diagram: `LayoutOptions`, `LayoutStrategy`, and `Positions`, now in `@latkit/gpu`; `LayoutGraph`, `LayoutVertex`, `LayoutEdge`, and `LayoutPort`, which `LayoutPart` replaces.
- network: placement on a circle, and the error for geographic data with vertices that have no position.
