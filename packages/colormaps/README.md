# @latkit/colormaps

The color vocabulary every Latkit renderer speaks: the `RGBA` a color option takes, the
`Colormap` a colormap option takes, the `COLORMAPS` catalog, and a CSS color parser. It has no
dependencies.

## Install

```sh
npm install @latkit/colormaps
```

## Basic use

```ts
import { COLORMAPS, colormap, gradient } from '@latkit/colormaps';

const viridis = colormap('viridis');
const [r, g, b] = viridis(0.5);

button.title = COLORMAPS.viridis.label;
button.style.background = gradient('viridis', 'to right');
```

A `Colormap` takes a normalized value in `[0, 1]` and returns RGB channels in `[0, 1]`; any
function of that shape works wherever a renderer takes one.

`COLORMAPS` is a frozen registry keyed by name. Each entry has a `label` and a `kind` (`'sequential'` or `'diverging'`); keys are in display order with sequential maps first.

`gradient()` takes a name or a colormap function, so a legend for a custom transfer function samples the same way the renderers do:

```ts
legend.style.background = gradient((t) => [t, 0.5, 1 - t]);
```

`parseColor()` turns a CSS color into the `RGBA` every color option takes; with an element it
resolves the color as that element computes it, so a theme's custom properties feed the renderers:

```ts
network.setOptions({ edgeBaseColor: parseColor('var(--edge)', document.body) ?? fallback });
```

`validateRgba(value, name)` is the check every color option runs, for a host that validates
before a renderer exists.
