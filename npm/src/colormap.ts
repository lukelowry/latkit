/** Colormaps as CSS gradients, for legends drawn in HTML. */

import type { Colormap } from './inputs.js';
import { wasm } from './internal.js';

/**
 * Returns a CSS `linear-gradient(...)` with the colors the GPU draws for `map`, a catalog name or a
 * custom colormap. `direction` is the gradient's CSS direction, `'to right'` by default. A
 * categorical map gives one solid band per category. Needs `await load()` first, and throws an
 * `invalid` error for an invalid `map`.
 */
export function colormapCss(map: Colormap, direction = 'to right'): string {
  return wasm().colormapCss(JSON.stringify(map), direction);
}
