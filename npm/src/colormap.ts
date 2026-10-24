/** Colormaps in the page: the colors the GPU draws, as CSS, for legends. */

import type { Colormap } from './inputs.js';
import { wasm } from './internal.js';

/**
 * A CSS gradient through `map`, a catalog name or colors of your own, toward `direction`: the colors
 * the GPU draws, a band each for a categorical map's categories.
 */
export function colormapCss(map: Colormap, direction = 'to right'): string {
  return wasm().colormapCss(JSON.stringify(map), direction);
}
