# Colors and colormaps

Name a catalog colormap wherever a scale takes one, or pass your own.

```ts
import { colormaps, colormapCss, reverseColormap } from '@latkit/gpu';

network.set({
  vertices: { Bus: { color: { field: 'temperature', domain: [250, 350], colormap: 'thermal' } } },
});
legend.style.backgroundImage = colormapCss(colormaps.thermal, { direction: 'to right' });
const reversed = reverseColormap(colormaps.thermal);
```

The catalog holds 46 maps, such as `viridis`, `cividis`, `thermal`, `balance`, `phase`, and
`okabeito`. Use sequential maps for magnitude, diverging maps around a center, cyclic maps for
phase, and categorical maps for labels. A `colormapCss` legend shows the same colors the GPU draws.
The network example's `/colors.html` previews the whole catalog.

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

Colors are RGBA in `[0, 1]`: sRGB with straight alpha. `parseColor` reads a CSS color literal
without a DOM. Continuous maps clamp, cyclic maps wrap, and categorical maps use hard bins. Create a
palette once and reuse it, since it is cached by identity.

Palette licenses are in
[THIRD_PARTY_NOTICES](https://github.com/lukelowry/latkit/blob/main/packages/gpu/THIRD_PARTY_NOTICES.md).
