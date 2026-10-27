/** The colormap catalog, and colormaps as CSS gradients for legends drawn in HTML. */

import type { Colormap, ColormapKind, ColormapName } from './inputs.js';
import { wasm } from './internal.js';

/**
 * Returns a CSS `linear-gradient(...)` with the colors the GPU draws for `map`, a catalog name or a
 * custom colormap. `direction` is the gradient's CSS direction, `'to right'` by default. A
 * categorical map gives one solid band per category.
 */
export function colormapCss(map: Colormap, direction = 'to right'): string {
  return wasm().colormapCss(JSON.stringify(map), direction);
}

/**
 * The catalog's colormaps, in order: each one's name, its title for people, such as
 * `'Red / Blue'`, and its kind.
 */
export function colormaps(): { name: ColormapName; label: string; kind: ColormapKind }[] {
  return JSON.parse(wasm().colormaps()) as ReturnType<typeof colormaps>;
}
