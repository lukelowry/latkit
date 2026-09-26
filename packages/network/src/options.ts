import { devices, type DevicePool } from '@latkit/gpu';
import { validateDomain, validateRgba, type Colormap, type Domain, type RGBA } from '@latkit/model';

import type { FocusEndpointMode } from './focus-state.js';

/** How camera motion is animated: following the user's preference, always reduced, or always full. */
export type Motion = 'auto' | 'reduce' | 'full';

/** What a plain wheel does: zoom the view, or scroll the page unless a modifier is held. */
export type Wheel = 'zoom' | 'modifier';

/** Where pointer, wheel, and keys go: the camera, item inspection only, or nowhere. */
export type Interaction = 'navigate' | 'inspect' | 'none';

/** A CSS-pixel inset: one value for every side, or `[top, right, bottom, left]`. */
export type Insets = number | readonly [number, number, number, number];

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
  /** Multiplier applied to the topology-derived vertex radius before its pixel cap, at most 8. @defaultValue `1`. */
  vertexScale?: number;
  /** Multiplier applied to the topology-derived edge half-width before pixel clamps, at most 8. @defaultValue `1`. */
  edgeScale?: number;
  /** Multiplier applied to vertex-height displacement, at most 8. @defaultValue `1`. */
  heightScale?: number;
  /** Output range the normalized `vertexHeight` channel maps onto. @defaultValue `[0, 1]`. */
  heightRange?: Domain;
  /** Radius multipliers the normalized `vertexSize` channel maps onto. @defaultValue `[0.5, 2]`. */
  sizeRange?: Domain;
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
  /** Minimum brightness on the night side of overlay geometry, in `[0, 1]`. @defaultValue `0.55`. */
  nightFloor?: number;
  /** Minimum brightness on the night side of opaque surfaces, in `[0, 1]`. @defaultValue `0.1`. */
  surfaceNightFloor?: number;
  /** Softness of the day/night terminator in shader units, at most 1. @defaultValue `0.12`. */
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
  /**
   * What input does. `'navigate'` moves the camera. `'inspect'` keeps hover, tap selection with
   * cycling, and keyboard stepping along the topology, and leaves wheel and touch scrolling to the
   * page. `'none'` installs no listeners at all. @defaultValue `'navigate'`.
   */
  interaction?: Interaction;
  /** Inset every fit keeps clear, in CSS pixels; `null` keeps the default margin. @defaultValue `null`. */
  fitPaddingPx?: Insets | null;
  /** Pitch a fit rests at, in degrees; `null` is the view's own rest. Flat ignores it. @defaultValue `null`. */
  fitPitch?: number | null;
  /** Bearing a fit rests at, in degrees clockwise from north. Flat ignores it. @defaultValue `0`. */
  fitBearing?: number;
}

/**
 * Validation kind, default, whether `Network.setOptions` accepts the option live, whether `null` is
 * a value, the label a control shows, and for a bounded number its inclusive `min` and `max`.
 */
export type OptionDefinition = { readonly label: string } & (
  | { readonly kind: 'boolean'; readonly default: boolean; readonly live: true }
  | {
      readonly kind: 'finite' | 'nonnegative';
      readonly default: number | null;
      readonly live: true;
      readonly nullable?: true;
      readonly min?: number;
      readonly max?: number;
    }
  | {
      readonly kind: 'rgba';
      readonly default: RGBA | null;
      readonly live: true;
      readonly nullable?: true;
    }
  | { readonly kind: 'domain'; readonly default: Domain; readonly live: true }
  | {
      readonly kind: 'insets';
      readonly default: Insets | null;
      readonly live: true;
      readonly nullable: true;
    }
  | {
      readonly kind: 'enum';
      readonly values: readonly (string | number)[];
      readonly default: string | number | undefined;
      readonly live: boolean;
    }
  | { readonly kind: 'colormap'; readonly default: Colormap; readonly live: true }
  | { readonly kind: 'pool'; readonly default: DevicePool; readonly live: false }
);

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
  msaa: {
    kind: 'enum',
    values: values(1, 4),
    default: undefined,
    live: false,
    label: 'Antialiasing',
  },
  devices: { kind: 'pool', default: devices, live: false, label: 'Device pool' },
  vertices: { kind: 'boolean', default: true, live: true, label: 'Vertices' },
  edges: { kind: 'boolean', default: true, live: true, label: 'Edges' },
  poles: { kind: 'boolean', default: false, live: true, label: 'Height poles' },
  vertexScale: { kind: 'nonnegative', default: 1, live: true, label: 'Vertex size', max: 8 },
  edgeScale: { kind: 'nonnegative', default: 1, live: true, label: 'Edge width', max: 8 },
  heightScale: { kind: 'nonnegative', default: 1, live: true, label: 'Height scale', max: 8 },
  heightRange: { kind: 'domain', default: tuple(0, 1), live: true, label: 'Height range' },
  sizeRange: { kind: 'domain', default: tuple(0.5, 2), live: true, label: 'Size range' },
  dashPeriodPx: { kind: 'nonnegative', default: 12, live: true, label: 'Dash period' },
  borders: { kind: 'boolean', default: true, live: true, label: 'Borders' },
  graticule: { kind: 'boolean', default: false, live: true, label: 'Graticule' },
  earthAxis: { kind: 'boolean', default: true, live: true, label: 'Earth axis' },
  daylight: { kind: 'boolean', default: true, live: true, label: 'Daylight' },
  sunTime: { kind: 'finite', default: null, live: true, nullable: true, label: 'Sun time' },
  nightFloor: {
    kind: 'finite',
    default: 0.55,
    live: true,
    label: 'Night brightness',
    min: 0,
    max: 1,
  },
  surfaceNightFloor: {
    kind: 'finite',
    default: 0.1,
    live: true,
    label: 'Surface night brightness',
    min: 0,
    max: 1,
  },
  terminatorWidth: {
    kind: 'nonnegative',
    default: 0.12,
    live: true,
    label: 'Terminator width',
    max: 1,
  },
  vertexBaseColor: {
    kind: 'rgba',
    default: tuple(0.5, 0.5, 0.5, 1),
    live: true,
    label: 'Vertex base color',
  },
  edgeBaseColor: {
    kind: 'rgba',
    default: null,
    live: true,
    nullable: true,
    label: 'Edge base color',
  },
  colormap: { kind: 'colormap', default: neutralColormap, live: true, label: 'Colormap' },
  graticuleColor: {
    kind: 'rgba',
    default: tuple(0.45, 0.48, 0.54, 1),
    live: true,
    label: 'Graticule color',
  },
  surfaceColor: {
    kind: 'rgba',
    default: tuple(0.15, 0.16, 0.19, 1),
    live: true,
    label: 'Surface color',
  },
  borderColor: {
    kind: 'rgba',
    default: tuple(0.52, 0.5, 0.49, 1),
    live: true,
    label: 'Border color',
  },
  focusEnabled: { kind: 'boolean', default: true, live: true, label: 'Highlight focus' },
  hoverColor: {
    kind: 'rgba',
    default: tuple(0.72, 0.28, 0.18, 1),
    live: true,
    label: 'Hover color',
  },
  selectedColor: {
    kind: 'rgba',
    default: tuple(0.72, 0.28, 0.18, 1),
    live: true,
    label: 'Selection color',
  },
  hoverAlpha: { kind: 'nonnegative', default: 0.5, live: true, label: 'Hover opacity' },
  selectedAlpha: { kind: 'nonnegative', default: 0.82, live: true, label: 'Selection opacity' },
  vertexHoverPx: { kind: 'nonnegative', default: 6, live: true, label: 'Vertex hover halo' },
  vertexSelectedPx: { kind: 'nonnegative', default: 7, live: true, label: 'Vertex selection halo' },
  edgeHoverPx: { kind: 'nonnegative', default: 3.5, live: true, label: 'Edge hover halo' },
  edgeSelectedPx: { kind: 'nonnegative', default: 5, live: true, label: 'Edge selection halo' },
  focusEndpointMode: {
    kind: 'enum',
    values: values('off', 'selected', 'hover-selected'),
    default: 'selected',
    live: true,
    label: 'Endpoint highlight',
  },
  motion: {
    kind: 'enum',
    values: values('auto', 'reduce', 'full'),
    default: 'auto',
    live: true,
    label: 'Motion',
  },
  animationMs: { kind: 'nonnegative', default: 500, live: true, label: 'Animation duration' },
  orbitRate: { kind: 'nonnegative', default: 1, live: true, label: 'Orbit speed' },
  revealPaddingPx: { kind: 'nonnegative', default: 48, live: true, label: 'Reveal padding' },
  pickRadiusPx: { kind: 'nonnegative', default: 10, live: true, label: 'Pick radius' },
  keyboard: { kind: 'boolean', default: true, live: true, label: 'Keyboard' },
  wheel: {
    kind: 'enum',
    values: values('zoom', 'modifier'),
    default: 'zoom',
    live: true,
    label: 'Wheel',
  },
  interaction: {
    kind: 'enum',
    values: values('navigate', 'inspect', 'none'),
    default: 'navigate',
    live: true,
    label: 'Interaction',
  },
  fitPaddingPx: { kind: 'insets', default: null, live: true, nullable: true, label: 'Fit padding' },
  fitPitch: { kind: 'finite', default: null, live: true, nullable: true, label: 'Fit pitch' },
  fitBearing: { kind: 'finite', default: 0, live: true, label: 'Fit bearing' },
} as const satisfies Record<keyof Required<Options>, OptionDefinition>;

for (const definition of Object.values(definitions)) Object.freeze(definition);

/** Every option: its validation kind, default, whether it is accepted live, label, and bounds. */
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
    const owned = Array.isArray(value) ? Object.freeze([...(value as readonly number[])]) : value;
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
    case 'nonnegative':
      validateNumber(key, value, definition.kind === 'nonnegative');
      if ('min' in definition && (value as number) < definition.min!) {
        throw new RangeError(`network option ${key} must be at least ${definition.min}`);
      }
      if ('max' in definition && (value as number) > definition.max!) {
        throw new RangeError(`network option ${key} must be at most ${definition.max}`);
      }
      return;
    case 'rgba':
      validateRgba(value, `network option ${key}`);
      return;
    case 'domain':
      validateDomain(value, `network option ${key}`);
      return;
    case 'insets': {
      const sides = typeof value === 'number' ? [value] : value;
      if (!Array.isArray(sides) || (sides.length !== 1 && sides.length !== 4)) {
        typeError(key, 'a number or [top, right, bottom, left]');
      }
      for (const side of sides) validateNumber(key, side, true);
      return;
    }
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
