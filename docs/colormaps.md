# Colormaps

`@latkit/colormaps` provides named transfer functions and labels that can be shared between network, monitor, and legend UI.

## Use a colormap

```ts
import { colormap } from '@latkit/colormaps';

network.setColormap(colormap('viridis'));
monitor.setColormap(colormap('magma'));
```

The returned function accepts a normalized value in `[0, 1]` and returns RGB channels in `[0, 1]`.

## Build a legend

Use `COLORMAP_LABEL` for display text and `colormapGradientCss()` for a CSS gradient that matches the same evaluator used by the renderers.

```ts
import { COLORMAP_LABEL, colormap, colormapGradientCss } from '@latkit/colormaps';

const button = document.createElement('button');
button.type = 'button';
button.title = COLORMAP_LABEL.viridis;
button.style.background = colormapGradientCss('viridis', 'to right');
button.addEventListener('click', () => network.setColormap(colormap('viridis')));
```

## Choose sequential or diverging maps

Sequential maps encode magnitude. Diverging maps encode signed deviation around a midpoint.

```ts
import { COLORMAP_NAMES, isDiverging } from '@latkit/colormaps';

const divergingNames = COLORMAP_NAMES.filter((name) => isDiverging(name));
```

Use sequential maps for quantities like load or count. Use diverging maps for quantities where values above and below a reference point both matter.
