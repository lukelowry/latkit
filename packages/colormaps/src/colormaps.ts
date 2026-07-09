type Rgb01 = readonly [number, number, number];
type CoefficientRows = readonly [Rgb01, Rgb01, Rgb01, Rgb01, Rgb01, Rgb01];

/**
 * Maps a normalized scalar to an RGB color.
 *
 * @param t - Normalized value. Values outside `[0, 1]` are clamped.
 * @returns RGB channels in `[0, 1]`.
 *
 * Input values are clamped to `[0, 1]`, and returned channels are also in
 * `[0, 1]`.
 */
export type Colormap = (t: number) => readonly [number, number, number];

/**
 * High-level colormap family.
 *
 * Sequential maps encode magnitude. Diverging maps encode signed deviation
 * around a midpoint.
 */
export type ColormapKind = 'sequential' | 'diverging';

/** Supported CSS gradient directions for {@link colormapGradientCss}. */
export type ColormapGradientDirection = 'to top' | 'to right';

/**
 * Bundled colormap names in display order.
 *
 * @remarks
 * The first group contains sequential maps for magnitude-like values. The
 * second group contains diverging maps for signed deviation around a midpoint.
 */
export const COLORMAP_NAMES = [
  'viridis',
  'inferno',
  'plasma',
  'magma',
  'cividis',
  'turbo',
  'grays',
  'blues',
  'reds',
  'greens',
  'amber',
  'coolwarm',
  'rdbu',
  'spectral',
  'piyg',
  'icefire',
  'berlin',
  'rkb',
  'mkg',
  'purgreen',
  'goldblue',
  'tealpink',
  'vermlime',
] as const;

/** Name of a bundled colormap preset. */
export type ColormapName = (typeof COLORMAP_NAMES)[number];

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
  viridis: packCoefficients([
    [0.2777, 0.0054, 0.334],
    [0.105, 0.6282, 0.2254],
    [-0.3308, 0.1786, 1.6523],
    [6.2288, -7.052, -1.316],
    [-11.616, 14.201, -5.7557],
    [7.8858, -7.9581, 4.4432],
  ]),
  inferno: packCoefficients([
    [0.0002, 0.0016, 0.0139],
    [0.1065, 0.0639, 0.7242],
    [11.6024, -3.9728, -15.9423],
    [-41.704, 17.4363, 44.3541],
    [77.1629, -33.4024, -81.8093],
    [-27.6685, 14.1791, 29.2463],
  ]),
  plasma: packCoefficients([
    [0.0591, 0.0015, 0.5399],
    [0.8493, 0.0263, -1.5191],
    [-3.0926, 3.4178, 5.1599],
    [15.8869, -14.6287, -15.8176],
    [-23.6815, 21.2975, 20.4548],
    [10.0689, -9.8108, -8.5088],
  ]),
  magma: packCoefficients([
    [-0.0021, -0.0007, -0.0054],
    [0.2517, 0.6775, 2.494],
    [8.3537, -3.5777, 0.3145],
    [-27.6687, 14.2647, -13.6492],
    [52.1761, -27.9436, 12.9442],
    [-26.9493, 17.0629, -1.2939],
  ]),
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
} satisfies Readonly<Record<ColormapName, Float32Array>>;

/** Family metadata for each bundled colormap. */
export const COLORMAP_KIND: Readonly<Record<ColormapName, ColormapKind>> = {
  viridis: 'sequential',
  inferno: 'sequential',
  plasma: 'sequential',
  magma: 'sequential',
  cividis: 'sequential',
  turbo: 'sequential',
  grays: 'sequential',
  blues: 'sequential',
  reds: 'sequential',
  greens: 'sequential',
  amber: 'sequential',

  coolwarm: 'diverging',
  rdbu: 'diverging',
  spectral: 'diverging',
  piyg: 'diverging',
  icefire: 'diverging',
  berlin: 'diverging',
  rkb: 'diverging',
  mkg: 'diverging',
  purgreen: 'diverging',
  goldblue: 'diverging',
  tealpink: 'diverging',
  vermlime: 'diverging',
};

/** Human-readable label for each bundled colormap. */
export const COLORMAP_LABEL: Readonly<Record<ColormapName, string>> = {
  viridis: 'Viridis',
  inferno: 'Inferno',
  plasma: 'Plasma',
  magma: 'Magma',
  cividis: 'Cividis',
  turbo: 'Turbo',
  grays: 'Grays',
  blues: 'Blues',
  reds: 'Reds',
  greens: 'Greens',
  amber: 'Amber',

  coolwarm: 'Cool-Warm',
  rdbu: 'Red-Blue',
  spectral: 'Spectral',
  piyg: 'Pink-Green',
  icefire: 'Icefire',
  berlin: 'Berlin',
  rkb: 'Red-Blue Dark',
  mkg: 'Magenta-Green',
  purgreen: 'Purple-Green',
  goldblue: 'Gold-Blue',
  tealpink: 'Teal-Pink',
  vermlime: 'Vermilion-Lime',
};

/**
 * Checks whether a bundled colormap is diverging.
 *
 * @param name - Bundled colormap name.
 * @returns True if the colormap is diverging; false otherwise.
 */
export function isDiverging(name: ColormapName): boolean {
  return COLORMAP_KIND[name] === 'diverging';
}

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
  const coefficients = COEFFICIENTS[name];
  return (t) => evaluateRgb01(coefficients, t);
}

/**
 * Builds a CSS `linear-gradient()` from the same evaluator as `colormap`.
 *
 * @param name - Bundled colormap name.
 * @param direction - CSS gradient direction. Default: `"to top"`.
 * @returns A CSS `linear-gradient()` string suitable for legends and swatches.
 *
 * @example
 * ```ts
 * legend.style.background = colormapGradientCss('magma', 'to right');
 * ```
 *
 * Use `to top` for vertical legends and `to right` for horizontal swatches.
 */
export function colormapGradientCss(
  name: ColormapName,
  direction: ColormapGradientDirection = 'to top',
): string {
  const fn = colormap(name);
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
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}
