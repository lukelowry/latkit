# Colormaps

`@latkit/colormaps` provides named transfer functions and a registry of labels and kinds that can be shared between network, monitor, and legend UI.

## Use a colormap

```ts
import { colormap } from '@latkit/colormaps';

network.setOptions({ colormap: colormap('viridis') });
monitor.setColormap(colormap('magma'));
```

The returned function accepts a normalized value in `[0, 1]` and returns RGB channels in `[0, 1]`.

## Build a legend

`COLORMAPS` is a frozen registry keyed by colormap name. Use `COLORMAPS[name].label` for display text and `gradient()` for a CSS gradient that matches the same evaluator used by the renderers.

```ts
import { COLORMAPS, colormap, gradient, type ColormapName } from '@latkit/colormaps';

for (const name of Object.keys(COLORMAPS) as ColormapName[]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = COLORMAPS[name].label;
  button.style.background = gradient(name, 'to right');
  button.addEventListener('click', () => network.setOptions({ colormap: colormap(name) }));
  picker.appendChild(button);
}
```

Registry keys are in display order: sequential maps first, then diverging maps. `gradient()` defaults to `'to top'` for vertical legends; pass `'to right'` for horizontal swatches.

## Choose sequential or diverging maps

Sequential maps encode magnitude. Diverging maps encode signed deviation around a midpoint. Each registry entry reports its family through `kind`.

```ts
import { COLORMAPS, type ColormapName } from '@latkit/colormaps';

const names = Object.keys(COLORMAPS) as ColormapName[];
const divergingNames = names.filter((name) => COLORMAPS[name].kind === 'diverging');
```

Use sequential maps for quantities like load or count. Use diverging maps for quantities where values above and below a reference point both matter.
