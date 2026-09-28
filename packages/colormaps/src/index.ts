/**
 * `@latkit/colormaps` — the color vocabulary every latkit renderer speaks: the `RGBA` a color option
 * takes and its check, the `Colormap` a colormap option takes, the `COLORMAPS` catalog with its
 * transfer functions and CSS gradients, and a CSS color parser.
 *
 * @packageDocumentation
 */

export type { RGBA } from './color.js';
export { parseColor, validateRgba } from './color.js';

export type { Colormap, ColormapName } from './colormaps.js';
export { COLORMAPS, colormap, gradient } from './colormaps.js';
