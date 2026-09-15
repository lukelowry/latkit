import { PERCEPTUAL } from './perceptual.js';
import type { Colormap } from '@latkit/model';

type Rgb01 = readonly [number, number, number];
type CoefficientRows = readonly [Rgb01, Rgb01, Rgb01, Rgb01, Rgb01, Rgb01];

/**
 * Bundled colormap registry in display order.
 *
 * @remarks
 * Each entry carries a human-readable `label` and a `kind`. Sequential maps
 * encode magnitude; diverging maps encode signed deviation around a midpoint.
 * Iterate `Object.keys(COLORMAPS)` for pickers: sequential maps come first.
 */
export const COLORMAPS = Object.freeze({
  // Sequential maps.
  viridis: { label: 'Viridis', kind: 'sequential' },
  inferno: { label: 'Inferno', kind: 'sequential' },
  plasma: { label: 'Plasma', kind: 'sequential' },
  magma: { label: 'Magma', kind: 'sequential' },
  cividis: { label: 'Cividis', kind: 'sequential' },
  turbo: { label: 'Turbo', kind: 'sequential' },
  grays: { label: 'Grays', kind: 'sequential' },
  blues: { label: 'Blues', kind: 'sequential' },
  reds: { label: 'Reds', kind: 'sequential' },
  greens: { label: 'Greens', kind: 'sequential' },
  amber: { label: 'Amber', kind: 'sequential' },

  // Diverging maps.
  coolwarm: { label: 'Cool-Warm', kind: 'diverging' },
  rdbu: { label: 'Red-Blue', kind: 'diverging' },
  spectral: { label: 'Spectral', kind: 'diverging' },
  piyg: { label: 'Pink-Green', kind: 'diverging' },
  icefire: { label: 'Icefire', kind: 'diverging' },
  berlin: { label: 'Berlin', kind: 'diverging' },
  rkb: { label: 'Red-Blue Dark', kind: 'diverging' },
  mkg: { label: 'Magenta-Green', kind: 'diverging' },
  purgreen: { label: 'Purple-Green', kind: 'diverging' },
  goldblue: { label: 'Gold-Blue', kind: 'diverging' },
  tealpink: { label: 'Teal-Pink', kind: 'diverging' },
  vermlime: { label: 'Vermilion-Lime', kind: 'diverging' },
} as const satisfies Record<
  string,
  { readonly label: string; readonly kind: 'sequential' | 'diverging' }
>);

/** Name of a bundled colormap preset. */
export type ColormapName = keyof typeof COLORMAPS;

function packCoefficients(rows: CoefficientRows): Float32Array {
  const out = new Float32Array(24);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    out[i * 4] = row[0];
    out[i * 4 + 1] = row[1];
    out[i * 4 + 2] = row[2];
  }
  return out;
}

function linearRamp(a: Rgb01, b: Rgb01): Float32Array {
  const out = new Float32Array(24);
  for (let ch = 0; ch < 3; ch++) {
    out[ch] = a[ch];
    out[4 + ch] = b[ch] - a[ch];
  }
  return out;
}

function divergingBlack(a: Rgb01, b: Rgb01): Float32Array {
  const out = new Float32Array(24);
  for (let ch = 0; ch < 3; ch++) {
    out[ch] = a[ch];
    out[4 + ch] = -3 * a[ch] - b[ch];
    out[8 + ch] = 2 * (a[ch] + b[ch]);
  }
  return out;
}

const COEFFICIENTS = {
  // Sequential perceptual maps.
  cividis: packCoefficients([
    [0, 0.13, 0.3],
    [0.69, 0.42, 0.32],
    [0.3, 0.36, -0.4],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]),
  turbo: packCoefficients([
    [0.114, 0.0628, 0.2248],
    [6.7164, 3.1831, 7.5715],
    [-66.094, 23.101, -91.126],
    [281.16, -124.19, 303.69],
    [-486.5, 206.66, -446.38],
    [289.26, -103.78, 232.55],
  ]),

  // Sequential single-hue maps.
  grays: linearRamp([0, 0, 0], [1, 1, 1]),
  blues: linearRamp([0.05, 0.1, 0.25], [0.55, 0.8, 1]),
  reds: linearRamp([0.2, 0.05, 0.05], [1, 0.5, 0.4]),
  greens: linearRamp([0.05, 0.2, 0.1], [0.5, 1, 0.45]),
  amber: linearRamp([0.15, 0.08, 0], [1, 0.78, 0.2]),

  // Diverging maps with light midpoints.
  coolwarm: packCoefficients([
    [0.23, 0.299, 0.754],
    [0.8135, -0.2309, -1.3019],
    [-3.8271, 6.8281, 20.0781],
    [22.5781, -9.9792, -61.9844],
    [-35.2604, -0.0781, 66.7969],
    [16.1719, 3.1771, -24.1927],
  ]),
  rdbu: packCoefficients([
    [0.404, 0, 0.122],
    [4.341, 1.4963, 1.3247],
    [-17.6208, 2.3687, -6.9833],
    [44.1198, -0.5521, 32.8438],
    [-55.7292, -9.8438, -46.6667],
    [24.5052, 6.7188, 19.7396],
  ]),
  spectral: packCoefficients([
    [0.37, 0.31, 0.64],
    [2.27, 3.07, 0.82],
    [-2.02, -3.38, -1.2],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]),
  piyg: packCoefficients([
    [0.56, 0, 0.31],
    [2.05, 4.1, 1.55],
    [-2.46, -3.71, -1.76],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]),

  // Diverging maps with black midpoints.
  icefire: divergingBlack([0, 0.85, 0.95], [0.95, 0.1, 0]),
  berlin: divergingBlack([0.1, 0.55, 0.95], [0.95, 0.65, 0]),
  rkb: divergingBlack([0.95, 0.1, 0], [0, 0.1, 0.95]),
  mkg: divergingBlack([0.95, 0, 0.95], [0, 0.85, 0.1]),
  purgreen: divergingBlack([0.55, 0, 0.85], [0.55, 0.85, 0]),
  goldblue: divergingBlack([0.95, 0.75, 0], [0, 0.3, 0.95]),
  tealpink: divergingBlack([0, 0.65, 0.65], [0.95, 0.45, 0.55]),
  vermlime: divergingBlack([0.95, 0.3, 0.1], [0.4, 0.85, 0]),
} satisfies Record<Exclude<ColormapName, keyof typeof PERCEPTUAL>, Float32Array>;

const maps = new Map<ColormapName, Colormap>();

/**
 * Returns a pure colormap function for a bundled preset.
 *
 * @param name - Bundled colormap name.
 * @returns A transfer function from normalized scalar values to RGB channels.
 *
 * @example
 * ```ts
 * const viridis = colormap('viridis');
 * const [r, g, b] = viridis(0.5);
 * ```
 */
export function colormap(name: ColormapName): Colormap {
  const cached = maps.get(name);
  if (cached) return cached;
  const map = createColormap(name);
  maps.set(name, map);
  return map;
}

function createColormap(name: ColormapName): Colormap {
  if (Object.hasOwn(PERCEPTUAL, name)) {
    const table = PERCEPTUAL[name as keyof typeof PERCEPTUAL];
    return (t) => {
      const at = clamp01(t) * (table.length / 3 - 1),
        left = Math.floor(at),
        right = Math.min(left + 1, table.length / 3 - 1),
        mix = at - left;
      const a = left * 3,
        b = right * 3,
        weight = 1 - mix;
      return [
        table[a]! * weight + table[b]! * mix,
        table[a + 1]! * weight + table[b + 1]! * mix,
        table[a + 2]! * weight + table[b + 2]! * mix,
      ];
    };
  }
  const coefficients = COEFFICIENTS[name as keyof typeof COEFFICIENTS];
  return (t) => evaluateRgb01(coefficients, t);
}

/**
 * Builds a CSS `linear-gradient()` from the same evaluator as `colormap`.
 *
 * @param map - Bundled colormap name, or any colormap function.
 * @param direction - CSS gradient direction. Default: `"to top"`.
 * @returns A CSS `linear-gradient()` string suitable for legends and swatches.
 *
 * @example
 * ```ts
 * legend.style.background = gradient('magma', 'to right');
 * swatch.style.background = gradient((t) => [t, 0, 1 - t]);
 * ```
 *
 * Use `to top` for vertical legends and `to right` for horizontal swatches.
 */
export function gradient(
  map: ColormapName | Colormap,
  direction: 'to top' | 'to right' = 'to top',
): string {
  const fn = typeof map === 'function' ? map : colormap(map);
  const stops: string[] = [];

  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const [r, g, b] = fn(t);
    stops.push(`${rgbCss(r, g, b)} ${Math.round(t * 100)}%`);
  }

  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}

function evaluateRgb01(coefficients: Float32Array, t: number): Rgb01 {
  const s = clamp01(t);
  const r = polynomialChannel(coefficients, s, 0);
  const g = polynomialChannel(coefficients, s, 1);
  const b = polynomialChannel(coefficients, s, 2);
  return [clamp01(r), clamp01(g), clamp01(b)];
}

function polynomialChannel(coefficients: Float32Array, t: number, channel: 0 | 1 | 2): number {
  return (
    coefficients[channel] +
    t *
      (coefficients[4 + channel] +
        t *
          (coefficients[8 + channel] +
            t *
              (coefficients[12 + channel] +
                t * (coefficients[16 + channel] + t * coefficients[20 + channel]))))
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rgbCss(r: number, g: number, b: number): string {
  return `rgb(${byte(r)},${byte(g)},${byte(b)})`;
}

/** An 8-bit channel from a normalized value; non-finite output of a custom map reads as 0. */
function byte(value: number): number {
  return Number.isFinite(value) ? Math.round(clamp01(value) * 255) : 0;
}
