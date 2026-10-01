# Colors and colormaps

Import all color helpers from `@latkit/gpu`.

```ts
import { colormaps, colormapCss, reverseColormap, sampleColormap } from '@latkit/gpu';

network.setVertex('node', {
  color: { field: 'temperature', domain: [250, 350], colormap: colormaps.thermal },
});
legend.style.backgroundImage = colormapCss(colormaps.thermal, { direction: 'to right' });
const reversed = reverseColormap(colormaps.thermal);
const rgba = sampleColormap(colormaps.thermal, 0.5);
```

Use sequential maps for magnitude, diverging maps for a center, cyclic maps for
phase, and categorical maps for labels. The catalog contains 46 maps, including
`viridis`, `cividis`, `thermal`, `balance`, `phase`, and `okabeito`.

## Create a palette

```ts
import { createColormap, parseColor } from '@latkit/gpu';

const temperature = createColormap({
  kind: 'diverging',
  interpolation: 'oklab',
  stops: [
    { at: 0, color: parseColor('#2166ac')! },
    { at: 0.5, color: parseColor('#f7f7f7')! },
    { at: 1, color: parseColor('#b2182b')! },
  ],
});
```

Keep palettes immutable and reuse their identity.
RGBA components are in `[0, 1]`, with sRGB color and straight alpha.
CPU, CSS, and GPU sampling share a quantized rendering table.
Continuous inputs clamp; cyclic inputs wrap; categories use hard bins.

`parseColor` parses literals without a DOM. Use
`resolveColor('var(--accent)', element)` for contextual CSS.

Palette licenses are in
[THIRD_PARTY_NOTICES](https://github.com/lukelowry/latkit/blob/main/packages/gpu/THIRD_PARTY_NOTICES.md).
The network example's `/colors.html` previews the full catalog.
