/** The colormap catalog, and colormaps as CSS gradients for legends drawn in HTML. */

import { CATALOG } from './catalog.js';
import type { Colormap } from './inputs.js';
import { wasm } from './internal.js';

/**
 * Returns a CSS `linear-gradient(...)` with the colors the GPU draws for `map`, a catalog name or a
 * custom colormap. `direction` is the CSS gradient direction and defaults to `'to right'`. A
 * categorical map gives one solid band per category.
 */
export function colormapCss(map: Colormap, direction = 'to right'): string {
  return wasm().colormapCss(JSON.stringify(map), direction);
}

/**
 * Returns the catalog's colormaps in order, each with its name, its label such as `'Red / Blue'`,
 * its kind, and its colors as a custom colormap takes them. Needs no WebAssembly.
 */
export function colormaps(): typeof CATALOG {
  return CATALOG;
}
