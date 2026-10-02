import type { Colormap } from './colormap.js';
import type { RGBA } from './color.js';
import { presets, type ColormapName } from './presets/data.js';
import { GpuError } from '../error.js';

export type { ColormapName } from './presets/data.js';
function preset(value: (typeof presets)[ColormapName]): Colormap {
  let colors: readonly RGBA[] | undefined;
  return Object.freeze({
    kind: value.kind,
    label: value.label,
    get colors() {
      if (!colors) {
        const data = JSON.parse(value.rgb) as number[];
        colors = Object.freeze(
          Array.from(
            { length: data.length / 3 },
            (_, i) => Object.freeze([data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 1]) as RGBA,
          ),
        );
      }
      return colors;
    },
  });
}
function buildCatalog(): Readonly<Record<ColormapName, Colormap>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(presets).map(([name, data]) => [name, preset(data)])),
  ) as Readonly<Record<ColormapName, Colormap>>;
}
/** Named immutable values; accessing metadata never decodes their sample tables. */
export const colormaps = /* @__PURE__ */ buildCatalog();
/** A colormap, or the catalog's by name. */
export function namedColormap(value: Colormap | ColormapName): Colormap {
  const map = typeof value === 'string' ? colormaps[value] : value;
  if (!map) throw new GpuError('invalid-input', 'Unknown colormap: ' + (value as string));
  return map;
}
