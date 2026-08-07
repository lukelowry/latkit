# @latkit/embed

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
