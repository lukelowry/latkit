import { devices, type DevicePool } from '@latkit/gpu';
import { validateDomain, validateRgba, type Colormap, type Domain, type RGBA } from '@latkit/model';

import type { FocusEndpointMode } from './focus-state.js';

/** How camera motion is animated: following the user's preference, always reduced, or always full. */
export type Motion = 'auto' | 'reduce' | 'full';

/** What a plain wheel does: zoom the view, or scroll the page unless a modifier is held. */
export type Wheel = 'zoom' | 'modifier';

/**
 * Network display options: the construction record and the live patch.
 *
 * @remarks
 * `msaa` and `devices` are read once at construction. Every other field seeds the initial view and
 * can be patched later with `Network.setOptions`; `OPTIONS` says which and carries each default.
 * An option marked nullable takes `null` to hand the decision back to the controller.
 */
export interface Options {
  /**
   * Multisample anti-aliasing sample count selected at construction.
   *
   * @defaultValue Automatically selects `4` on typical displays and `1` on very large device-pixel surfaces.
   */
  msaa?: 1 | 4;
  /** Where `Network.attach` leases its device. @defaultValue the realm-wide pool from `@latkit/gpu`. */
  devices?: DevicePool;
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
  /** Radius multipliers the normalized `vertexSize` channel maps onto. @defaultValue `[0.5, 2]`. */
  sizeRange?: Domain;
  /** Vertex level-of-detail threshold in CSS pixels. @defaultValue `2`. */
  vertexLodPx?: number;
  /** Screen-space edge dash period in CSS pixels. @defaultValue `12`. */
  dashPeriodPx?: number;
  /** Draw geographic border overlays; drawn only over a geographic topology. @defaultValue `true`. */
  borders?: boolean;
  /** Draw projection graticule lines. @defaultValue `false`. */
  graticule?: boolean;
  /** Draw the globe earth-axis indicator when supported. @defaultValue `true`. */
  earthAxis?: boolean;
  /** Enable solar-terminator daylight shading on geographic topologies. @defaultValue `true`. */
  daylight?: boolean;
  /** The instant daylight is computed for, in milliseconds since the epoch; `null` follows the clock. @defaultValue `null`. */
  sunTime?: number | null;
  /** Minimum brightness on the night side of overlay geometry. @defaultValue `0.55`. */
  nightFloor?: number;
  /** Minimum brightness on the night side of opaque surfaces. @defaultValue `0.1`. */
  surfaceNightFloor?: number;
  /** Softness of the day/night terminator in shader units. @defaultValue `0.12`. */
  terminatorWidth?: number;
  /** Resting vertex color without a `vertexColor` channel. @defaultValue `[0.5, 0.5, 0.5, 1]`. */
  vertexBaseColor?: RGBA;
  /** Resting edge color without an `edgeColor` channel; `null` averages the endpoint colors. @defaultValue `null`. */
  edgeBaseColor?: RGBA | null;
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
  /**
   * Camera and orbit motion. `'auto'` follows `prefers-reduced-motion`; under reduced motion every
   * fit, reveal, and pose lands at once, drags do not coast, and `orbit(true)` is refused.
   * @defaultValue `'auto'`.
   */
  motion?: Motion;
  /** Duration of an animated fit, reveal, or pose, in milliseconds. @defaultValue `500`. */
  animationMs?: number;
  /** Multiplier on the continuous rotation rate of `orbit`. @defaultValue `1`. */
  orbitRate?: number;
  /** Inset an item must clear before `reveal` leaves it in place, in CSS pixels. @defaultValue `48`. */
  revealPaddingPx?: number;
  /** Pick radius for mouse hover, taps, and `hitTest`, in CSS pixels; touch uses at least 22. @defaultValue `10`. */
  pickRadiusPx?: number;
  /**
   * Attach the keyboard map to the canvas: arrows pan, Shift with arrows rotates, plus and minus
   * zoom, Home fits, Escape clears the selection. The canvas becomes focusable when it is not.
   * @defaultValue `true`.
   */
  keyboard?: boolean;
  /** Whether a plain wheel zooms, or only a Ctrl or Meta wheel does while the page keeps scrolling. @defaultValue `'zoom'`. */
  wheel?: Wheel;
}

/** Validation kind, default, whether `Network.setOptions` accepts the option live, and whether `null` is a value. */
export type OptionDefinition =
  | { readonly kind: 'boolean'; readonly default: boolean; readonly live: true }
  | {
      readonly kind: 'finite' | 'nonnegative';
      readonly default: number | null;
      readonly live: true;
      readonly nullable?: true;
    }
  | {
      readonly kind: 'rgba';
      readonly default: RGBA | null;
      readonly live: true;
      readonly nullable?: true;
    }
  | { readonly kind: 'domain'; readonly default: Domain; readonly live: true }
  | {
      readonly kind: 'enum';
      readonly values: readonly (string | number)[];
      readonly default: string | number | undefined;
      readonly live: boolean;
    }
  | { readonly kind: 'colormap'; readonly default: Colormap; readonly live: true }
  | { readonly kind: 'pool'; readonly default: DevicePool; readonly live: false };

/** Network's neutral transfer function before a consumer supplies a colormap. */
const neutralColormap: Colormap = Object.freeze((t: number) => [t, t, t] as const);

/** Freeze a tuple default before exposing it through public metadata. */
function tuple<T extends readonly number[]>(...values: T): Readonly<T> {
  return Object.freeze(values);
}

/** Freeze an enumerated value list before exposing it through public metadata. */
function values<const T extends readonly (string | number)[]>(...entries: T): T {
  return Object.freeze(entries) as T;
}

const definitions = {
  msaa: { kind: 'enum', values: values(1, 4), default: undefined, live: false },
  devices: { kind: 'pool', default: devices, live: false },
  vertices: { kind: 'boolean', default: true, live: true },
  edges: { kind: 'boolean', default: true, live: true },
  poles: { kind: 'boolean', default: false, live: true },
  vertexScale: { kind: 'nonnegative', default: 1, live: true },
  edgeScale: { kind: 'nonnegative', default: 1, live: true },
  heightScale: { kind: 'nonnegative', default: 1, live: true },
  heightRange: { kind: 'domain', default: tuple(0, 1), live: true },
  sizeRange: { kind: 'domain', default: tuple(0.5, 2), live: true },
  vertexLodPx: { kind: 'nonnegative', default: 2, live: true },
  dashPeriodPx: { kind: 'nonnegative', default: 12, live: true },
  borders: { kind: 'boolean', default: true, live: true },
  graticule: { kind: 'boolean', default: false, live: true },
  earthAxis: { kind: 'boolean', default: true, live: true },
  daylight: { kind: 'boolean', default: true, live: true },
  sunTime: { kind: 'finite', default: null, live: true, nullable: true },
  nightFloor: { kind: 'finite', default: 0.55, live: true },
  surfaceNightFloor: { kind: 'finite', default: 0.1, live: true },
  terminatorWidth: { kind: 'nonnegative', default: 0.12, live: true },
  vertexBaseColor: { kind: 'rgba', default: tuple(0.5, 0.5, 0.5, 1), live: true },
  edgeBaseColor: { kind: 'rgba', default: null, live: true, nullable: true },
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
  focusEndpointMode: {
    kind: 'enum',
    values: values('off', 'selected', 'hover-selected'),
    default: 'selected',
    live: true,
  },
  motion: { kind: 'enum', values: values('auto', 'reduce', 'full'), default: 'auto', live: true },
  animationMs: { kind: 'nonnegative', default: 500, live: true },
  orbitRate: { kind: 'nonnegative', default: 1, live: true },
  revealPaddingPx: { kind: 'nonnegative', default: 48, live: true },
  pickRadiusPx: { kind: 'nonnegative', default: 10, live: true },
  keyboard: { kind: 'boolean', default: true, live: true },
  wheel: { kind: 'enum', values: values('zoom', 'modifier'), default: 'zoom', live: true },
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
    : Exclude<Options[Key], undefined>;
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
      (definition.kind === 'rgba' || definition.kind === 'domain') && value !== null
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
  if (value === null && 'nullable' in definition && definition.nullable) return;
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
      validateRgba(value, `network option ${key}`);
      return;
    case 'domain':
      validateDomain(value, `network option ${key}`);
      return;
    case 'enum':
      if (!definition.values.includes(value as string | number)) {
        typeError(key, `one of ${definition.values.map(String).join(', ')}`);
      }
      return;
    case 'colormap':
      if (typeof value !== 'function') typeError(key, 'a colormap function');
      return;
    case 'pool':
      if (typeof (value as Partial<DevicePool> | null)?.acquire !== 'function') {
        typeError(key, 'a device pool');
      }
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

function typeError(key: string, expected: string): never {
  throw new TypeError(`network option ${key} must be ${expected}`);
}
