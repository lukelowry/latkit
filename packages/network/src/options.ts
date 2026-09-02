import type { FocusEndpointMode, RGBA } from './focus-state.js';
import { type Domain, validateDomain } from './range.js';

/** Function mapping a normalized scalar to normalized RGB channels. */
export type Colormap = (t: number) => readonly [number, number, number];

/**
 * Network display options: the construction record and the live patch.
 *
 * @remarks
 * `msaa` is read once at construction. Every other field seeds the initial view and can be
 * patched later with `Network.setOptions`; `OPTIONS` says which and carries each default.
 */
export interface Options {
  /**
   * Multisample anti-aliasing sample count selected at construction.
   *
   * @defaultValue Automatically selects `4` on typical displays and `1` on very large device-pixel surfaces.
   */
  msaa?: 1 | 4;
  /** Draw vertex billboards. @defaultValue `true`. */
  vertices?: boolean;
  /** Draw edge segments. @defaultValue `true`. */
  edges?: boolean;
  /** Draw height poles when a `vertexHeight` channel is active. @defaultValue `false`. */
  poles?: boolean;
  /** Multiplier applied to the topology-derived vertex radius before its pixel cap. @defaultValue `1`. */
  vertexScale?: number;
  /** Multiplier applied to the topology-derived edge half-width before pixel clamps. @defaultValue `1`. */
  edgeScale?: number;
  /** Multiplier applied to vertex-height displacement. @defaultValue `1`. */
  heightScale?: number;
  /** Output range the normalized `vertexHeight` channel maps onto. @defaultValue `[0, 1]`. */
  heightRange?: Domain;
  /** Vertex level-of-detail threshold in CSS pixels. @defaultValue `2`. */
  vertexLodPx?: number;
  /** Screen-space edge dash period in CSS pixels. @defaultValue `12`. */
  dashPeriodPx?: number;
  /** Draw geographic border overlays. @defaultValue `true`. */
  borders?: boolean;
  /** Draw projection graticule lines. @defaultValue `false`. */
  graticule?: boolean;
  /** Draw the globe earth-axis indicator when supported. @defaultValue `true`. */
  earthAxis?: boolean;
  /** Enable solar-terminator daylight shading on geographic topologies. @defaultValue `true`. */
  daylight?: boolean;
  /** Minimum brightness on the night side of overlay geometry. @defaultValue `0.55`. */
  nightFloor?: number;
  /** Minimum brightness on the night side of opaque surfaces. @defaultValue `0.1`. */
  surfaceNightFloor?: number;
  /** Softness of the day/night terminator in shader units. @defaultValue `0.12`. */
  terminatorWidth?: number;
  /** Resting vertex color without a `vertexColor` channel. @defaultValue `[0.5, 0.5, 0.5, 1]`. */
  baseColor?: RGBA;
  /** Seeds the color lookup texture used by colormap channels. @defaultValue A neutral gray ramp. */
  colormap?: Colormap;
  /** Graticule line color as normalized RGBA. @defaultValue `[0.45, 0.48, 0.54, 1]`. */
  graticuleColor?: RGBA;
  /** Ground plane (flat/tilt) and globe sphere base color. @defaultValue `[0.15, 0.16, 0.19, 1]`. */
  surfaceColor?: RGBA;
  /** Geographic border tint; shaders retain tier alpha. @defaultValue `[0.52, 0.5, 0.49, 1]`. */
  borderColor?: RGBA;
  /** Enable hover and selection highlighting. @defaultValue `true`. */
  focusEnabled?: boolean;
  /** Hover highlight color. @defaultValue `[0.72, 0.28, 0.18, 1]`. */
  hoverColor?: RGBA;
  /** Selection highlight color. @defaultValue `[0.72, 0.28, 0.18, 1]`. */
  selectedColor?: RGBA;
  /** Multiplier applied to hover color alpha. @defaultValue `0.5`. */
  hoverAlpha?: number;
  /** Multiplier applied to selection color alpha. @defaultValue `0.82`. */
  selectedAlpha?: number;
  /** Additional hover radius around vertices in CSS pixels. @defaultValue `6`. */
  vertexHoverPx?: number;
  /** Additional selection radius around vertices in CSS pixels. @defaultValue `7`. */
  vertexSelectedPx?: number;
  /** Additional hover half-width around edges in CSS pixels. @defaultValue `3.5`. */
  edgeHoverPx?: number;
  /** Additional selection half-width around edges in CSS pixels. @defaultValue `5`. */
  edgeSelectedPx?: number;
  /** Endpoint highlight mode for focused edges. @defaultValue `"selected"`. */
  focusEndpointMode?: FocusEndpointMode;
}

/** Validation kind, default, and whether `Network.setOptions` accepts the option live. */
export type OptionDefinition =
  | { readonly kind: 'boolean'; readonly default: boolean; readonly live: true }
  | { readonly kind: 'finite' | 'nonnegative'; readonly default: number; readonly live: true }
  | { readonly kind: 'rgba'; readonly default: RGBA; readonly live: true }
  | { readonly kind: 'domain'; readonly default: Domain; readonly live: true }
  | { readonly kind: 'focus-endpoint'; readonly default: FocusEndpointMode; readonly live: true }
  | { readonly kind: 'colormap'; readonly default: Colormap; readonly live: true }
  | { readonly kind: 'msaa'; readonly default: undefined; readonly live: false };

/** Network's neutral transfer function before a consumer supplies a colormap. */
const neutralColormap: Colormap = Object.freeze((t: number) => [t, t, t] as const);

/** Freeze a tuple default before exposing it through public metadata. */
function tuple<T extends readonly number[]>(...values: T): Readonly<T> {
  return Object.freeze(values);
}

const definitions = {
  msaa: { kind: 'msaa', default: undefined, live: false },
  vertices: { kind: 'boolean', default: true, live: true },
  edges: { kind: 'boolean', default: true, live: true },
  poles: { kind: 'boolean', default: false, live: true },
  vertexScale: { kind: 'nonnegative', default: 1, live: true },
  edgeScale: { kind: 'nonnegative', default: 1, live: true },
  heightScale: { kind: 'nonnegative', default: 1, live: true },
  heightRange: { kind: 'domain', default: tuple(0, 1), live: true },
  vertexLodPx: { kind: 'nonnegative', default: 2, live: true },
  dashPeriodPx: { kind: 'nonnegative', default: 12, live: true },
  borders: { kind: 'boolean', default: true, live: true },
  graticule: { kind: 'boolean', default: false, live: true },
  earthAxis: { kind: 'boolean', default: true, live: true },
  daylight: { kind: 'boolean', default: true, live: true },
  nightFloor: { kind: 'finite', default: 0.55, live: true },
  surfaceNightFloor: { kind: 'finite', default: 0.1, live: true },
  terminatorWidth: { kind: 'nonnegative', default: 0.12, live: true },
  baseColor: { kind: 'rgba', default: tuple(0.5, 0.5, 0.5, 1), live: true },
  colormap: { kind: 'colormap', default: neutralColormap, live: true },
  graticuleColor: { kind: 'rgba', default: tuple(0.45, 0.48, 0.54, 1), live: true },
  surfaceColor: { kind: 'rgba', default: tuple(0.15, 0.16, 0.19, 1), live: true },
  borderColor: { kind: 'rgba', default: tuple(0.52, 0.5, 0.49, 1), live: true },
  focusEnabled: { kind: 'boolean', default: true, live: true },
  hoverColor: { kind: 'rgba', default: tuple(0.72, 0.28, 0.18, 1), live: true },
  selectedColor: { kind: 'rgba', default: tuple(0.72, 0.28, 0.18, 1), live: true },
  hoverAlpha: { kind: 'nonnegative', default: 0.5, live: true },
  selectedAlpha: { kind: 'nonnegative', default: 0.82, live: true },
  vertexHoverPx: { kind: 'nonnegative', default: 6, live: true },
  vertexSelectedPx: { kind: 'nonnegative', default: 7, live: true },
  edgeHoverPx: { kind: 'nonnegative', default: 3.5, live: true },
  edgeSelectedPx: { kind: 'nonnegative', default: 5, live: true },
  focusEndpointMode: { kind: 'focus-endpoint', default: 'selected', live: true },
} as const satisfies Record<keyof Required<Options>, OptionDefinition>;

for (const definition of Object.values(definitions)) Object.freeze(definition);

/** Every option: its validation kind, default, and whether it is accepted live. */
export const OPTIONS: Readonly<typeof definitions> = Object.freeze(definitions);

/** Option keys selected by whether they are accepted live. */
type OptionKeyByLive<Live extends boolean> = {
  [Key in keyof typeof OPTIONS]: (typeof OPTIONS)[Key]['live'] extends Live ? Key : never;
}[keyof typeof OPTIONS];

/** Options accepted as live Network patches. */
export type RuntimeOption = OptionKeyByLive<true>;

/** Fully resolved Network options, including automatic `undefined` defaults. */
export type ResolvedOptions = Readonly<{
  [Key in keyof typeof OPTIONS]: undefined extends (typeof OPTIONS)[Key]['default']
    ? Options[Key] | undefined
    : NonNullable<Options[Key]>;
}>;

/** Build the default record mechanically from the canonical definitions. */
function resolveDefaults(): ResolvedOptions {
  const entries = Object.entries(OPTIONS).map(([key, definition]) => [key, definition.default]);
  return Object.freeze(Object.fromEntries(entries)) as ResolvedOptions;
}

/** Deeply immutable resolved defaults used by Network itself. */
export const DEFAULT_OPTIONS = resolveDefaults();

/** Resolve and own a complete construction option record. */
export function resolveOptions(options: Options): ResolvedOptions {
  validateOptions(options);
  const values = options as Readonly<Record<string, unknown>>;
  const entries = Object.entries(OPTIONS).map(([key, definition]) => {
    const supplied = values[key];
    const value = supplied === undefined ? definition.default : supplied;
    const owned =
      definition.kind === 'rgba' || definition.kind === 'domain'
        ? Object.freeze([...(value as readonly number[])])
        : value;
    return [key, owned];
  });
  return Object.freeze(Object.fromEntries(entries)) as ResolvedOptions;
}

/**
 * Validate an option patch completely before any of it is applied.
 *
 * @throws TypeError or RangeError naming the first invalid option.
 */
export function validateOptions(options: Options): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('network options must be an object');
  }
  for (const [key, definition] of Object.entries(OPTIONS)) {
    const value = options[key as keyof Options];
    if (value === undefined) continue;
    validateOptionValue(key, definition, value);
  }
}

/** Validate one supplied value according to its canonical metadata. */
function validateOptionValue(key: string, definition: OptionDefinition, value: unknown): void {
  switch (definition.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') typeError(key, 'a boolean');
      return;
    case 'finite':
      validateNumber(key, value, false);
      return;
    case 'nonnegative':
      validateNumber(key, value, true);
      return;
    case 'rgba':
      validateRgba(key, value);
      return;
    case 'domain':
      validateDomain(value, `network option ${key}`);
      return;
    case 'focus-endpoint':
      if (value !== 'off' && value !== 'selected' && value !== 'hover-selected') {
        typeError(key, 'a focus endpoint mode');
      }
      return;
    case 'colormap':
      if (typeof value !== 'function') typeError(key, 'a colormap function');
      return;
    case 'msaa':
      if (value !== 1 && value !== 4) typeError(key, '1 or 4');
      return;
    default:
      definition satisfies never;
  }
}

function validateNumber(key: string, value: unknown, nonnegative: boolean): void {
  if (typeof value !== 'number') typeError(key, 'a number');
  if (!Number.isFinite(value)) throw new RangeError(`network option ${key} must be finite`);
  if (nonnegative && value < 0) {
    throw new RangeError(`network option ${key} must be nonnegative`);
  }
}

function validateRgba(key: string, value: unknown): void {
  if (!Array.isArray(value) || value.length !== 4) typeError(key, 'an RGBA tuple');
  for (const component of value) {
    if (typeof component !== 'number') typeError(key, 'an RGBA tuple');
    if (!Number.isFinite(component) || component < 0 || component > 1) {
      throw new RangeError(`network option ${key} RGBA components must be finite and in [0, 1]`);
    }
  }
}

function typeError(key: string, expected: string): never {
  throw new TypeError(`network option ${key} must be ${expected}`);
}
