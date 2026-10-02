# @latkit/model

## 0.14.0

### Minor Changes

- 145a02d: Breaking change: remove model retention and historical reads. Models publish one-pass passive
  transactions, commands are a separate optional capability, and applications own immutable
  columnar Data. Views consume Data directly and accept updates with set({ source: nextData }).
  Local read computes rows, samples, aggregates, and envelopes without contacting a producer.
  Connect protocol 3 removes queryable roots, retained reference trees, and remote exports;
  upgrade both peers together. Delivered values survive unsubscribe and disconnect. Shared
  unchanged pages preserve local read caching and GPU uploads.

## 0.13.0

### Minor Changes

- 1ade156: Topology is data: a reference field wires each row to a row of another type, and views draw
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

## 0.12.0

### Minor Changes

- 01975bd: Replace the previous model and rendering APIs with native Queryable data, explicit
  retained acquisitions, shared GPU rendering, and worker/socket connections.

  Network and monitor use the shared GPU and canvas-view lifecycle. Video exports
  renderers directly, including composed views. Colors now come from @latkit/gpu.
  Rewrite usage guides and package READMEs for these APIs.

  This is a breaking pre-1.0 release. Migrate consumers together; the retired port,
  colormaps, document-session, and scene-snapshot APIs have no compatibility exports.
  The diagram package remains private and declaration-only.
