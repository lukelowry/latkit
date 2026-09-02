# @latkit/colormaps

Colormap catalog for Latkit.

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

Colormap functions accept normalized values in `[0, 1]` and return RGB channels in `[0, 1]`.

`COLORMAPS` is a frozen registry keyed by name. Each entry has a `label` and a `kind` (`'sequential'` or `'diverging'`); keys are in display order with sequential maps first.
