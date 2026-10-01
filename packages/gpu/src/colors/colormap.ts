import { interpolateWithPremultipliedAlpha } from 'culori/fn';
import { freezeColor, validateRgba, type RGBA } from './color.js';
import { initializeColors, toRgba } from './conversion.js';

export type ColormapKind = 'sequential' | 'diverging' | 'cyclic' | 'categorical' | 'multihue';
/** Immutable presentation data. Continuous samples are uniformly spaced; cyclic samples omit t=1. */
export interface Colormap {
  readonly kind: ColormapKind;
  readonly label?: string;
  readonly colors: readonly RGBA[];
}
export interface ColorStop {
  readonly at: number;
  readonly color: RGBA;
}
export type ColormapOptions =
  | { readonly kind?: ColormapKind; readonly label?: string; readonly colors: readonly RGBA[] }
  | {
      readonly kind?: Exclude<ColormapKind, 'categorical'>;
      readonly label?: string;
      readonly stops: readonly ColorStop[];
      readonly size?: number;
      readonly interpolation?: 'srgb' | 'srgb-linear' | 'oklab';
    }
  | {
      readonly kind?: Exclude<ColormapKind, 'categorical'>;
      readonly label?: string;
      readonly sample: (t: number) => RGBA;
      readonly size?: number;
    };

const kinds: readonly string[] = ['sequential', 'diverging', 'cyclic', 'categorical', 'multihue'];
const validated = new WeakSet<Colormap>();
export function validateColormap(map: Colormap): void {
  if (validated.has(map)) return;
  if (!map || !kinds.includes(map.kind) || !Array.isArray(map.colors))
    throw new TypeError('Expected a colormap value');
  const min = map.kind === 'categorical' ? 1 : 2;
  if (map.colors.length < min || map.colors.length > 16384)
    throw new RangeError(`Colormaps require ${min} to 16384 colors`);
  if (map.label !== undefined && typeof map.label !== 'string')
    throw new TypeError('Invalid colormap label');
  for (const color of map.colors) validateRgba(color);
  // Structural values are immutable by contract; factory results also enforce it at runtime.
  if (Object.isFrozen(map) && Object.isFrozen(map.colors) && map.colors.every(Object.isFrozen))
    validated.add(map);
}

/** Copies and freezes authoring data once. Callbacks are evaluated only during construction. */
export function createColormap(options: ColormapOptions): Colormap {
  const kind = options.kind ?? 'sequential';
  if (!kinds.includes(kind)) throw new TypeError('Invalid colormap kind');
  if (options.label !== undefined && typeof options.label !== 'string')
    throw new TypeError('Invalid colormap label');
  let colors: readonly RGBA[];
  if ('colors' in options) {
    validateColormap({ kind, colors: options.colors });
    colors = options.colors.map(freezeColor);
  } else {
    if (kind === 'categorical') throw new TypeError('Categorical maps require explicit colors');
    const size = options.size ?? 256;
    if (!Number.isSafeInteger(size) || size < 2 || size > 16384)
      throw new RangeError('Colormap size must be an integer from 2 to 16384');
    let sample: (t: number) => RGBA;
    if ('sample' in options) sample = options.sample;
    else {
      if (!Array.isArray(options.stops)) throw new TypeError('Expected color stops');
      const stops = options.stops as readonly ColorStop[];
      if (
        stops.length < 2 ||
        stops.length > 16384 ||
        stops[0].at !== 0 ||
        stops[stops.length - 1].at !== 1
      )
        throw new RangeError('Stops must cover [0, 1]');
      for (let i = 0; i < stops.length; i++) {
        if (!Number.isFinite(stops[i].at) || (i && stops[i].at <= stops[i - 1].at))
          throw new RangeError('Stops must be finite and strictly increasing');
        validateRgba(stops[i].color);
      }
      if (
        kind === 'cyclic' &&
        stops[0].color.some((v, i) => v !== stops[stops.length - 1].color[i])
      )
        throw new RangeError('Cyclic stops must close at the same color');
      const space = options.interpolation ?? 'oklab';
      if (!['srgb', 'srgb-linear', 'oklab'].includes(space))
        throw new TypeError('Invalid interpolation space');
      initializeColors();
      const interpolate = interpolateWithPremultipliedAlpha(
        stops.map(({ at, color: c }) => [
          { mode: 'rgb' as const, r: c[0], g: c[1], b: c[2], alpha: c[3] },
          at,
        ]),
        space === 'srgb' ? 'rgb' : space === 'srgb-linear' ? 'lrgb' : 'oklab',
      );
      sample = (t) => {
        const color = toRgba(interpolate(t));
        if (!color) throw new TypeError('Interpolation produced an invalid color');
        return color;
      };
    }
    colors = Array.from({ length: size }, (_, i) =>
      freezeColor(sample(i / (kind === 'cyclic' ? size : size - 1))),
    );
  }
  const map: Colormap = Object.freeze({
    kind,
    ...(options.label === undefined ? {} : { label: options.label }),
    colors: Object.freeze(colors),
  });
  validateColormap(map);
  return map;
}
const reversed = new WeakMap<Colormap, Colormap>();
/** Cyclic reversal preserves the phase origin. Reversing twice returns the original identity. */
export function reverseColormap(map: Colormap): Colormap {
  validateColormap(map);
  let result = reversed.get(map);
  if (!result) {
    const colors =
      map.kind === 'cyclic'
        ? [map.colors[0], ...map.colors.slice(1).reverse()]
        : [...map.colors].reverse();
    result = Object.freeze({ ...map, colors: Object.freeze(colors) });
    reversed.set(map, result);
    reversed.set(result, map);
  }
  return result;
}
