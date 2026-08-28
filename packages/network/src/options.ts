import type { FocusEndpointMode, RGBA } from './focus-state.js';

/** Function mapping a normalized scalar to normalized RGB channels. */
export type NetworkColormap = (t: number) => readonly [number, number, number];

/**
 * Initial network renderer configuration and runtime option patch.
 *
 * @remarks
 * `msaa` is read once at construction. Other fields seed the initial view and
 * can be patched later with `Network.setOptions`.
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
  /** Enable time-based daylight shading. @defaultValue `true`. */
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
  colormap?: NetworkColormap;
  /** Graticule line color as normalized RGBA. @defaultValue `[0.45, 0.48, 0.54, 1]`. */
  graticuleColor?: RGBA;
  /** Tilt ground plane and globe sphere base color. @defaultValue `[0.15, 0.16, 0.19, 1]`. */
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

/** Validation and lifecycle metadata for a runtime-mutable option. */
export type RuntimeOptionDefinition =
  | { readonly kind: 'boolean'; readonly default: boolean }
  | { readonly kind: 'finite' | 'nonnegative'; readonly default: number }
  | { readonly kind: 'rgba'; readonly default: RGBA }
  | { readonly kind: 'focus-endpoint'; readonly default: FocusEndpointMode }
  | { readonly kind: 'colormap'; readonly default: NetworkColormap };

/** Canonical metadata for one Network option. */
export type OptionDefinition =
  | (RuntimeOptionDefinition & { readonly lifecycle: 'runtime' })
  | {
      readonly kind: 'msaa';
      readonly default: undefined;
      readonly lifecycle: 'construction';
    };

/** Network's neutral transfer function before a consumer supplies a colormap. */
const neutralColormap: NetworkColormap = Object.freeze((t: number) => [t, t, t] as const);

/** Freeze an RGBA default before exposing it through public metadata. */
function rgba(red: number, green: number, blue: number, alpha: number): RGBA {
  return Object.freeze([red, green, blue, alpha] as const);
}

const optionDefinitions = {
  msaa: { kind: 'msaa', default: undefined, lifecycle: 'construction' },
  vertices: { kind: 'boolean', default: true, lifecycle: 'runtime' },
  edges: { kind: 'boolean', default: true, lifecycle: 'runtime' },
  poles: { kind: 'boolean', default: false, lifecycle: 'runtime' },
  vertexScale: { kind: 'nonnegative', default: 1, lifecycle: 'runtime' },
  edgeScale: { kind: 'nonnegative', default: 1, lifecycle: 'runtime' },
  heightScale: { kind: 'nonnegative', default: 1, lifecycle: 'runtime' },
  vertexLodPx: { kind: 'nonnegative', default: 2, lifecycle: 'runtime' },
  dashPeriodPx: { kind: 'nonnegative', default: 12, lifecycle: 'runtime' },
  borders: { kind: 'boolean', default: true, lifecycle: 'runtime' },
  graticule: { kind: 'boolean', default: false, lifecycle: 'runtime' },
  earthAxis: { kind: 'boolean', default: true, lifecycle: 'runtime' },
  daylight: { kind: 'boolean', default: true, lifecycle: 'runtime' },
  nightFloor: { kind: 'finite', default: 0.55, lifecycle: 'runtime' },
  surfaceNightFloor: { kind: 'finite', default: 0.1, lifecycle: 'runtime' },
  terminatorWidth: { kind: 'nonnegative', default: 0.12, lifecycle: 'runtime' },
  baseColor: { kind: 'rgba', default: rgba(0.5, 0.5, 0.5, 1), lifecycle: 'runtime' },
  colormap: { kind: 'colormap', default: neutralColormap, lifecycle: 'runtime' },
  graticuleColor: {
    kind: 'rgba',
    default: rgba(0.45, 0.48, 0.54, 1),
    lifecycle: 'runtime',
  },
  surfaceColor: {
    kind: 'rgba',
    default: rgba(0.15, 0.16, 0.19, 1),
    lifecycle: 'runtime',
  },
  borderColor: {
    kind: 'rgba',
    default: rgba(0.52, 0.5, 0.49, 1),
    lifecycle: 'runtime',
  },
  focusEnabled: { kind: 'boolean', default: true, lifecycle: 'runtime' },
  hoverColor: {
    kind: 'rgba',
    default: rgba(0.72, 0.28, 0.18, 1),
    lifecycle: 'runtime',
  },
  selectedColor: {
    kind: 'rgba',
    default: rgba(0.72, 0.28, 0.18, 1),
    lifecycle: 'runtime',
  },
  hoverAlpha: { kind: 'nonnegative', default: 0.5, lifecycle: 'runtime' },
  selectedAlpha: { kind: 'nonnegative', default: 0.82, lifecycle: 'runtime' },
  vertexHoverPx: { kind: 'nonnegative', default: 6, lifecycle: 'runtime' },
  vertexSelectedPx: { kind: 'nonnegative', default: 7, lifecycle: 'runtime' },
  edgeHoverPx: { kind: 'nonnegative', default: 3.5, lifecycle: 'runtime' },
  edgeSelectedPx: { kind: 'nonnegative', default: 5, lifecycle: 'runtime' },
  focusEndpointMode: {
    kind: 'focus-endpoint',
    default: 'selected',
    lifecycle: 'runtime',
  },
} as const satisfies Record<keyof Required<Options>, OptionDefinition>;

for (const definition of Object.values(optionDefinitions)) Object.freeze(definition);

/** Canonical option names, defaults, validation kinds, and mutation lifecycles. */
export const OPTION_DEFINITIONS = Object.freeze(optionDefinitions);

/** Option keys selected mechanically by their canonical mutation lifecycle. */
export type OptionKeyByLifecycle<Lifecycle extends OptionDefinition['lifecycle']> = {
  [
    Key in keyof typeof OPTION_DEFINITIONS
  ]: (typeof OPTION_DEFINITIONS)[Key]['lifecycle'] extends Lifecycle ? Key : never;
}[keyof typeof OPTION_DEFINITIONS];

/** Options captured when a Network is constructed. */
export type ConstructionOption = OptionKeyByLifecycle<'construction'>;

/** Options accepted as live Network patches. */
export type RuntimeOption = OptionKeyByLifecycle<'runtime'>;

/** Fully resolved Network options, including automatic `undefined` defaults. */
export type ResolvedOptions = Readonly<{
  [
    Key in keyof typeof OPTION_DEFINITIONS
  ]: undefined extends (typeof OPTION_DEFINITIONS)[Key]['default']
    ? Options[Key] | undefined
    : NonNullable<Options[Key]>;
}>;

/** Build the public default record mechanically from the canonical definitions. */
function resolveDefaults(): ResolvedOptions {
  const entries = Object.entries(OPTION_DEFINITIONS).map(([key, definition]) => [
    key,
    definition.default,
  ]);
  return Object.freeze(Object.fromEntries(entries)) as ResolvedOptions;
}

/** Deeply immutable resolved defaults used by Network and higher-level consumers. */
export const DEFAULT_OPTIONS = resolveDefaults();

/** Resolve and own a complete construction option record. */
export function resolveOptions(options: Options): ResolvedOptions {
  validateOptions(options);
  const values = options as Readonly<Record<string, unknown>>;
  const entries = Object.entries(OPTION_DEFINITIONS).map(([key, definition]) => {
    const supplied = values[key];
    const value = supplied === undefined ? definition.default : supplied;
    return [key, definition.kind === 'rgba' ? Object.freeze([...(value as RGBA)]) : value];
  });
  return Object.freeze(Object.fromEntries(entries)) as ResolvedOptions;
}

/** Validate an option patch completely before the controller mutates renderer state. */
export function validateOptions(options: Options): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('network options must be an object');
  }
  for (const [key, definition] of Object.entries(OPTION_DEFINITIONS)) {
    const value = options[key as keyof Options];
    if (value === undefined) continue;
    validateOptionValue(key, definition, value);
  }
}

/** Validate one defined public option value through its canonical metadata. */
export function validateOption<Key extends keyof Options>(
  key: Key,
  value: unknown,
): asserts value is Exclude<Options[Key], undefined> {
  const definition = OPTION_DEFINITIONS[key];
  validateOptionValue(String(key), definition, value);
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
