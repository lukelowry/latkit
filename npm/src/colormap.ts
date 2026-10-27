/** The colormap catalog, and colormaps as CSS gradients for legends drawn in HTML. */

import type { Colormap, ColormapKind, ColormapName } from './inputs.js';
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
 * and its kind.
 */
export function colormaps(): { name: ColormapName; label: string; kind: ColormapKind }[] {
  return JSON.parse(wasm().colormaps()) as ReturnType<typeof colormaps>;
}
