# @latkit/colormaps

Colormap catalog for Latkit.

## Install

```sh
npm install @latkit/colormaps
```

## Basic use

```ts
import { COLORMAP_LABEL, colormap, colormapGradientCss } from '@latkit/colormaps';

const viridis = colormap('viridis');
const [r, g, b] = viridis(0.5);

button.title = COLORMAP_LABEL.viridis;
button.style.background = colormapGradientCss('viridis', 'to right');
```

Colormap functions accept normalized values in `[0, 1]` and return RGB channels in `[0, 1]`.
