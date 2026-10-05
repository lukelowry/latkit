---
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/diagram': minor
'@latkit/monitor': minor
---

A network draws each vertex with a marker: a shape, gauge, pie, or icon, or WGSL of your own, in CSS pixels. Animated changes ease on the GPU, flow moves as comets, and every view that zooms navigates the same way.

Added

- gpu: `shape`, `gauge`, `pie`, and `icon`, with the `Marker`, `MarkerImage`, and `Shape` types; `pulse`, a shade for rows whose `shade` is positive.
- gpu: `kit.checkMarker`, `kit.markerShader`, `kit.shapeShader`, `kit.markerAtlas`, `kit.SHAPES`, and `kit.MARKER_INPUTS`; `kit.readRows`; `kit.Grab`, which a view's `grab` returns to take a press before navigation.
- network: a vertex type's `marker`; `flowPx` on edges and paths, with `flowColor` and `flowSpacingPx`; `edgeSpacingPx`, `shadows`, `hoverScale`, and `labelHaloPx`.
- Every view that zooms: a touch held in place opens the context menu, and two pointers pinch.

Changed

- network: `set(…, { animate: true })` eases positions, colors, sizes, widths, flow, and marker inputs over `animationMs`, on the GPU; labels follow. Per-frame CPU work stays the same.
- network: hover grows a vertex's marker by `hoverScale`, 1.25 by default.
- network: a vertex's label sits in the widest gap between its edges.
- diagram: blocks draw with the shared shapes and shadow, and drag through the views' `grab`.
- monitor: a fit leaves `fitPaddingPx` clear around the values, in pixels, as every view's fit does. The monitor has no pointer navigation, so the page keeps wheel and touch scrolling.

Removed

- monitor: `domainPadding`; use `fitPaddingPx`.
- diagram: `Shape`, now in `@latkit/gpu`.
- gpu: `clicks` in a view's definition; a view takes the presses it handles with `grab`.
