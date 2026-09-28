# Colormaps

`@latkit/colormaps` is the color vocabulary every renderer speaks: the `RGBA` every color option takes, the `Colormap` every colormap option takes, a registry of named colormaps with labels and kinds to share between network, monitor, diagram, and legend UI, and `parseColor`, which reads a CSS color into an `RGBA`.

## Use a colormap

```ts
import { colormap } from '@latkit/colormaps';

network.setOptions({ colormap: colormap('viridis') });
monitor.setOptions({ colormap: colormap('magma') });
```

A `Colormap` takes a normalized value in `[0, 1]` and returns RGB channels in `[0, 1]`; any function of that shape works wherever a renderer takes one.

## Build a legend

`COLORMAPS` is a frozen registry keyed by colormap name. Use `COLORMAPS[name].label` for display text and `gradient()` for a CSS gradient that matches the same evaluator used by the renderers. `gradient()` also takes a colormap function, so a legend for a custom transfer function renders through the same sampler.

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

## Read and check colors

`parseColor(css, element?)` reads hex, `rgb()`, `oklab()`, `oklch()`, `color(srgb …)`, and `transparent`; with an element it resolves any color that element computes, custom properties included, so a theme feeds the renderers. `validateRgba(value, name)` is the check every color option runs, for a host that validates before a renderer exists.

```ts
import { parseColor } from '@latkit/colormaps';

network.setOptions({ edgeBaseColor: parseColor('var(--edge)', document.body) ?? fallback });
```
