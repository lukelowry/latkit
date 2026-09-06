# @latkit/colormaps

## 0.2.0

### Minor Changes

- 196e170: - Removed: the `Colormap` type export; import it from `@latkit/model`, which `@latkit/colormaps` now depends on.
- 196e170: `gradient` takes a colormap function as well as a name, so a legend for a custom transfer function renders through the same sampler as the presets.

### Patch Changes

- Updated dependencies [196e170]
- Updated dependencies [196e170]
  - @latkit/model@0.4.0

## 0.1.0

### Minor Changes

- 4219e1e: Collapse the catalog into one frozen `COLORMAPS` registry (`{ label, kind }` per name, sequential entries first) and rename `colormapGradientCss` to `gradient`. `COLORMAP_NAMES`, `COLORMAP_KIND`, `COLORMAP_LABEL`, `isDiverging`, `ColormapKind`, and `ColormapGradientDirection` are removed; `ColormapName` is now `keyof typeof COLORMAPS`.

## 0.0.1

### Patch Changes

- 669e369: Add Read the Docs-ready project documentation and generated TypeScript API reference metadata.
