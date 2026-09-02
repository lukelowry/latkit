# @latkit/embed

## 0.7.0

### Minor Changes

- 4219e1e: Build `latkit-network` on the tightened primitives of its dependencies and mirror the new `Network` surface one-to-one.

  - The device pool, colormap registry, and Network registries now come from `@latkit/gpu` (`createDevicePool`), `@latkit/colormaps` (`COLORMAPS`, `gradient`), and `@latkit/network` (`CHANNELS`, `OPTIONS`, `PROJECTIONS`, `validateOptions`) instead of private copies or removed helpers. The attribute table is derived from `OPTIONS` and `CHANNELS`.
  - `hover` and `select` DOM events carry an `Item | null` detail (`{ kind, index }`), `zoom` and the new `orbit` event carry a boolean, `deviceLost` carries `{ reason, message, recovering }`, and `pipelineError` carries `{ family, cause }`. The separate `*EventDetail` interfaces are gone; `NetworkElementEventMap` inlines every detail shape.
  - The element forwards exactly the `Network` verbs: `setOptions`, `setBorders`, `setChannel(channel, values | null, domain?)`, `setChannelDomain`, `getChannelDomain`, `setProjection(mode, fallback?)`, `fit`, `reveal`, `neighborhood`, `select(item | null)`, `panBy`, `rotateBy`, `getPose`, `setPose(pose, animate?)`, `zoomBy`, `orbit`, `pause`, and `resume`, plus the readonly `projections`, `geographic`, and `orbiting`.
  - The height output range is the ordinary live option `heightRange`, reflected as the `height-range` attribute; the per-channel `vertex-height-range` attribute and the fourth `setChannel` argument are gone.
  - Removed: `setColormap` (use `setOptions({ colormap })`), `setBaseColor` (use `setOptions({ baseColor })`), `clearChannel` (use `setChannel(channel, null)`), `setChannelRange` (use `setChannelDomain`), `clearSelection` (use `select(null)`), and `fadeIn`. The barrel exports only `register`, `parseNetwork`, and the types `NetworkElement`, `NetworkElementEventMap`, `NetworkData`, and `NetworkJSON`.

  The border binaries remain published under `@latkit/embed/assets/*` for the standalone bundle.

### Patch Changes

- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
- Updated dependencies [4219e1e]
  - @latkit/colormaps@0.1.0
  - @latkit/gpu@0.2.0
  - @latkit/network@0.7.0

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
