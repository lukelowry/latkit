# @latkit/network

## 0.8.0

### Minor Changes

- 196e170: One durable controller. `createNetwork(options)` is synchronous and takes neither a device nor a canvas; `attach(canvas)` leases a device and paints every retained state, `detach()` keeps it, and a lost device is replaced inside the controller.

  - Added: `attach`, `detach`, `attached`, the `attached` event, `recovering` on `deviceLost`, `load(topology, { fit })`, and the live `keyboard`, `motion`, and `wheel` options.
  - Changed: the `zoom` event is `fit`; `contextmenu` carries `{ event, keyboard, clientX, clientY, items }` with the hits already resolved; loading the topology already loaded is a no-op; borders draw only over a geographic topology; every channel slot is allocated at load.
  - Removed: the device and canvas arguments to `createNetwork`, and the `Topology`, `Item`, and `Domain` re-exports. Import them, and `validateTopology`, from `@latkit/model`.

- 196e170: Policy is an option; intent is an argument. `reveal(item, { neighbors, animate })` takes its two intents inline and the `RevealOptions` type is gone.

  - Added: `edgeBaseColor` (null averages the endpoint colors), `sizeRange` (the `vertexSize` channel's radius multipliers, the twin of `heightRange`), `sunTime` (null follows the clock), `animationMs`, `orbitRate`, `revealPaddingPx`, and `pickRadiusPx`.
  - Renamed: `baseColor` is `vertexBaseColor`.
  - Removed: `RevealOptions`, and with it `paddingPx` (now `revealPaddingPx`) and `center`; a visible item is left in place. `vertexLodPx` is gone: a vertex never zooms out of sight, its radius clamps to a 1.5 px floor the way an edge already keeps a 1 px half-width.

### Patch Changes

- 196e170: An edge ends at the rim of its endpoint discs instead of running under them, so a vertex always covers its own edges while true depth orders every other overlap. The edge shader discards fragments inside the disc the vertex pass draws, in every projection.

  - Changed: edges and focused edges write depth; halos, borders, and the earth axis only test it. Items of one kind share one depth bias, so overlapping edges or discs blend in draw order instead of cutting each other's anti-aliased fringe.

- Updated dependencies [196e170]
- Updated dependencies [196e170]
- Updated dependencies [196e170]
  - @latkit/gpu@0.3.0
  - @latkit/model@0.4.0

## 0.7.0

### Minor Changes

- 4219e1e: One controller, three registries. `Network` gains `neighborhood`, `reveal(item, { neighbors })`, `setProjection(mode, fallback)`, `orbit(active)` with `orbiting` and an `orbit` event, `setChannelDomain`, and `getChannelDomain`; `select(item | null)` replaces `select(kind, index)` and `clearSelection`; `setChannel(channel, null)` clears; `setPose(pose, animate)` takes a boolean; every event carries one payload (`hover` and `select` an `Item | null`, `deviceLost` and `pipelineError` an object); `setColormap`, `setBaseColor`, and `fadeIn` are gone (patch `colormap` and `baseColor` through `setOptions`; the host owns canvas visibility). The height output range is the live `heightRange` option. `CHANNELS`, `OPTIONS`, and `PROJECTIONS` replace `CHANNEL_DEFINITIONS`, `channelDefinition`, `channelNormalizes`, `OPTION_DEFINITIONS`, `DEFAULT_OPTIONS`, `validateOption`, and `PROJECTION_MODES`; `Projection`, `Pose`, and `Domain` replace `ProjectionMode`, `CameraPose`, and `ChannelRange`; `Topology` and `Item` are `@latkit/model`'s. `finiteExtent`, `validateChannelRange`, `validateBorders`, `adjacency`, `revealNeighborhood`, `preferProjection`, `canAutoRotate`, and `createOrbit` are no longer exported. The packaged Natural Earth borders load through `@latkit/network/borders`.

### Patch Changes

- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
  - @latkit/gpu@0.2.0
  - @latkit/model@0.3.0

## 0.6.1

### Patch Changes

- 986ed05: Require caller-supplied vertex coordinates for geographic interpretation: generated ring layouts no longer arm daylight shading, geographic ground clipping, the daylight refresh timer, or globe availability. Expose the stored interpretation as `Network.geographic` (mirrored by `NetworkElement.geographic`) and add an optional `Topology.coordinateSpace` declaration — `'cartesian'` keeps abstract data off geographic features even when its bounds fit lon/lat ranges — forwarded through the embed's serialized topology format.

## 0.6.0

### Minor Changes

- f061538: Unify flat, tilt, and globe navigation around a transferable camera pose; expose the active projection plus `getPose()` and `setPose()`, support pitch and bearing on the globe, and rename the public shader grouping type to `ProjectionFamily`. Apply shared solar-terminator daylight rendering across geographic projections, consolidate projection pipelines and picking math by family, and forward pose controls through `NetworkElement` and the standalone embed.

## 0.5.0

### Minor Changes

- 9a09a67: Add raw `vertexVisible` and `edgeVisible` channels with matching renderer, picking, Embed attributes, and lifecycle behavior; `Network` and `NetworkElement` consistently ignore range arguments for raw dash and visibility channels. Add `rotateBy()` plus live `vertexScale`, `edgeScale`, `heightScale`, `vertexLodPx`, and `dashPeriodPx` geometry controls with matching Embed attributes. Channel values are now snapshotted, topology fit bounds and visual scales consistently use vertices, crossing edge segments clip to positive W, teardown releases retained scene data, and asynchronous pipeline failures are exposed through `pipelineError` and forwarded by `NetworkElement` as a DOM event.

### Patch Changes

- 9a09a67: Validate encoded scenes once per topology load and stage picking indices before replacing the active renderer scene.

## 0.4.0

### Minor Changes

- 184bffc: Add view-preserving item reveal and forward it through `NetworkElement`. Export the
  colormap and option-definition types referenced by public renderer configuration. Unify flat
  and tilted height rendering, warm inactive projection pipelines serially after paints and
  topology loads, and remove duplicated topology preparation from the load path.

## 0.3.0

### Minor Changes

- 3ed363b: Add threshold-gated `contextmenu` events, synchronous CPU `hitTest` and `locate` queries, and subset fitting without changing the existing picker hot path. Forward subset fitting through `NetworkElement`.

## 0.2.0

### Minor Changes

- 17d22ec: Add the complete declarative Network embed, including durable view configuration, semantic controls, accessible interaction, shared-device recovery, packaged borders, and a bundled standalone browser entry. Export Network-owned channel, projection, option, color, focus, range, and border-validation semantics for higher-level consumers.

## 0.1.0

### Minor Changes

- 73786c4: Require application-owned native Core `GPUDevice` and `HTMLCanvasElement` instances so device sharing, canvas layout, and DOM ownership stay explicit.

### Patch Changes

- Updated dependencies [73786c4]
  - @latkit/gpu@0.1.0

## 0.0.2

### Patch Changes

- 4f87a78: Harden focus handling across pointer navigation, camera animation, and resize interactions.

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
