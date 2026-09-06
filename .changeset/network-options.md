---
'@latkit/network': minor
---

Policy is an option; intent is an argument. `reveal(item, { neighbors, animate })` takes its two intents inline and the `RevealOptions` type is gone.

- Added: `layering` (`'stacked'`, the default, paints borders under edges under poles under vertices with only the surface occluding; `'depth'` lets true depth decide), `baseEdgeColor` (null averages the endpoint colors), `sizeRange` (the `vertexSize` channel's radius multipliers, the twin of `heightRange`), `sunTime` (null follows the clock), `animationMs`, `orbitRate`, `revealPaddingPx`, and `pickRadiusPx`.
- Renamed: `baseColor` is `baseVertexColor`.
- Removed: `RevealOptions`, and with it `paddingPx` (now `revealPaddingPx`) and `center`; a visible item is left in place.
