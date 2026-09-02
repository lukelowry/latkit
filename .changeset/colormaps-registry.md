---
'@latkit/colormaps': minor
---

Collapse the catalog into one frozen `COLORMAPS` registry (`{ label, kind }` per name, sequential entries first) and rename `colormapGradientCss` to `gradient`. `COLORMAP_NAMES`, `COLORMAP_KIND`, `COLORMAP_LABEL`, `isDiverging`, `ColormapKind`, and `ColormapGradientDirection` are removed; `ColormapName` is now `keyof typeof COLORMAPS`.
