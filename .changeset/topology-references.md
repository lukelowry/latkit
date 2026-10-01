---
'@latkit/model': minor
'@latkit/gpu': minor
'@latkit/connect': minor
'@latkit/monitor': minor
'@latkit/network': minor
'@latkit/diagram': minor
---

Topology is data: a reference field wires each row to a row of another type, and views draw
those types as vertices and edges.

Added

- `Schema.types` with `TypeDefinition`, and `ReferenceColumn`: row numbers under the referenced
  type's `Index`, read like any field. `numberAt` reads them.
- `direction: 'in' | 'out'` on reference fields.
- `ends` on network and diagram edges: the two reference fields a row joins. Without `ends` an edge
  type is a net, joining the vertices whose references name each row.

Changed

- `spatial.system` is `'geographic' | 'cartesian'`; the network reads its coordinates from it.
- Diagram ports are the reference fields that name a drawn net; `arrows` is a boolean.
- `ConnectProposal.replaces` names the net and the port leaving it.
- A `reference` parameter takes `to`; problem targets are `row` and `field` with a type.

Renamed

- Diagram: `components`/`connections` → `vertices`/`edges`, `setComponent`/`setConnection` →
  `setVertex`/`setEdge`, item kinds `component`/`connection` → `vertex`/`edge`,
  `ComponentOptions`/`ConnectionOptions` → `VertexOptions`/`EdgeOptions`, `EntityRef` → `RowRef`,
  `ConnectionGesture` → `ConnectProposal`, `RouteEndpoint` → `RouteEnd`, `LayoutNode` →
  `LayoutVertex`, `Group.components` → `Group.vertices`.
- Diagram options and limits: `nodePadding`, `nodeGap`, `componentBaseColor`, `connectionBaseColor`,
  `connectionWidthPx`, `animationMaxComponents`, `connectionRadiusPx` → `vertexPadding`,
  `vertexGap`, `vertexBaseColor`, `edgeBaseColor`, `edgeWidthPx`, `animationMaxVertices`,
  `connectRadiusPx`; `components`/`connections`/`endpoints` → `vertices`/`edges`/`ends`.
- Network `focusEndpointMode` → `focusEnds`.

Removed

- `components`, `connections`, and `tables`, with `ComponentDefinition`, `ComponentPort`,
  `ConnectionDefinition`, `ConnectionRole`, and `TableDefinition`.
- The `endpoints` and `links` queries and blocks.
- Network `coordinates` and `connectivity`; diagram roles and end ordinals.
