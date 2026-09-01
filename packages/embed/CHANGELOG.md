# @latkit/embed

## 0.6.1

### Patch Changes

- 986ed05: Require caller-supplied vertex coordinates for geographic interpretation: generated ring layouts no longer arm daylight shading, geographic ground clipping, the daylight refresh timer, or globe availability. Expose the stored interpretation as `Network.geographic` (mirrored by `NetworkElement.geographic`) and add an optional `Topology.coordinateSpace` declaration — `'cartesian'` keeps abstract data off geographic features even when its bounds fit lon/lat ranges — forwarded through the embed's serialized topology format.
- Updated dependencies [986ed05]
  - @latkit/network@0.6.1

## 0.6.0

### Minor Changes

- f061538: Unify flat, tilt, and globe navigation around a transferable camera pose; expose the active projection plus `getPose()` and `setPose()`, support pitch and bearing on the globe, and rename the public shader grouping type to `ProjectionFamily`. Apply shared solar-terminator daylight rendering across geographic projections, consolidate projection pipelines and picking math by family, and forward pose controls through `NetworkElement` and the standalone embed.

### Patch Changes

- Updated dependencies [f061538]
  - @latkit/network@0.6.0

## 0.5.0

### Minor Changes

- 9a09a67: Add raw `vertexVisible` and `edgeVisible` channels with matching renderer, picking, Embed attributes, and lifecycle behavior; `Network` and `NetworkElement` consistently ignore range arguments for raw dash and visibility channels. Add `rotateBy()` plus live `vertexScale`, `edgeScale`, `heightScale`, `vertexLodPx`, and `dashPeriodPx` geometry controls with matching Embed attributes. Channel values are now snapshotted, topology fit bounds and visual scales consistently use vertices, crossing edge segments clip to positive W, teardown releases retained scene data, and asynchronous pipeline failures are exposed through `pipelineError` and forwarded by `NetworkElement` as a DOM event.

### Patch Changes

- Updated dependencies [9a09a67]
- Updated dependencies [9a09a67]
  - @latkit/network@0.5.0

## 0.4.0

### Minor Changes

- 184bffc: Add view-preserving item reveal and forward it through `NetworkElement`. Export the
  colormap and option-definition types referenced by public renderer configuration. Unify flat
  and tilted height rendering, warm inactive projection pipelines serially after paints and
  topology loads, and remove duplicated topology preparation from the load path.

### Patch Changes

- Updated dependencies [184bffc]
  - @latkit/network@0.4.0

## 0.3.0

### Minor Changes

- 3ed363b: Add threshold-gated `contextmenu` events, synchronous CPU `hitTest` and `locate` queries, and subset fitting without changing the existing picker hot path. Forward subset fitting through `NetworkElement`.

### Patch Changes

- Updated dependencies [3ed363b]
  - @latkit/network@0.3.0

## 0.2.0

### Minor Changes

- 17d22ec: Add the complete declarative Network embed, including durable view configuration, semantic controls, accessible interaction, shared-device recovery, packaged borders, and a bundled standalone browser entry. Export Network-owned channel, projection, option, color, focus, range, and border-validation semantics for higher-level consumers.

### Patch Changes

- Updated dependencies [17d22ec]
  - @latkit/network@0.2.0
