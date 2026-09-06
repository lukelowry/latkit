import { devices, type DevicePool } from '@latkit/gpu';
import { validateDomain, type Domain } from '@latkit/model';

/** Function mapping a normalized scalar to normalized RGB channels. */
export type Colormap = (t: number) => readonly [number, number, number];

/** Normalized RGBA color, each component in `[0, 1]`. */
export type RGBA = readonly [number, number, number, number];

/**
 * Monitor display options: the construction record and the live patch.
 *
 * @remarks
 * `devices` is read once at construction. Every other field seeds the initial view and can be
 * patched later with `Monitor.setOptions`; `OPTIONS` says which and carries each default. An
 * option marked nullable takes `null` to hand the decision back to the controller.
 */
export interface Options {
  /** Where `Monitor.attach` leases its device. @defaultValue the realm-wide pool from `@latkit/gpu`. */
  devices?: DevicePool;
  /** Transfer function for normalized values. @defaultValue A neutral gray ramp. */
  colormap?: Colormap;
  /** Trace stroke width in CSS pixels. @defaultValue `1.5`. */
  lineWidthPx?: number;
  /**
   * Fixed value domain for vertical position and color, or `null` to fit the finite extent of the
   * active signal's committed frames. @defaultValue `null`.
   */
  valueRange?: Domain | null;
  /** Time window shown across the canvas, or `null` for the series' full span. @defaultValue `null`. */
  timeRange?: Domain | null;
  /** Color of the selected element's trace, or `null` to brighten its own color. @defaultValue `null`. */
  focusColor?: RGBA | null;
  /** Alpha of every other trace while an element is selected. @defaultValue `1`. */
  unselectedAlpha?: number;
}

/** Validation kind, default, whether `Monitor.setOptions` accepts the option live, and whether `null` is a value. */
export type OptionDefinition =
  | { readonly kind: 'pool'; readonly default: DevicePool; readonly live: false }
  | { readonly kind: 'colormap'; readonly default: Colormap; readonly live: true }
  | { readonly kind: 'nonnegative'; readonly default: number; readonly live: true }
  | {
      readonly kind: 'domain';
      readonly default: Domain | null;
      readonly live: true;
      readonly nullable?: true;
    }
  | {
      readonly kind: 'rgba';
      readonly default: RGBA | null;
      readonly live: true;
      readonly nullable?: true;
    };

/** Monitor's neutral transfer function before a consumer supplies a colormap. */
const neutralColormap: Colormap = Object.freeze((t: number) => [t, t, t] as const);

const definitions = {
  devices: { kind: 'pool', default: devices, live: false },
  colormap: { kind: 'colormap', default: neutralColormap, live: true },
  lineWidthPx: { kind: 'nonnegative', default: 1.5, live: true },
  valueRange: { kind: 'domain', default: null, live: true, nullable: true },
  timeRange: { kind: 'domain', default: null, live: true, nullable: true },
  focusColor: { kind: 'rgba', default: null, live: true, nullable: true },
  unselectedAlpha: { kind: 'nonnegative', default: 1, live: true },
} as const satisfies Record<keyof Required<Options>, OptionDefinition>;

for (const definition of Object.values(definitions)) Object.freeze(definition);

/** Every option: its validation kind, default, and whether it is accepted live. */
export const OPTIONS: Readonly<typeof definitions> = Object.freeze(definitions);

/** Fully resolved Monitor options. */
export type ResolvedOptions = Readonly<{
  [Key in keyof typeof OPTIONS]: Exclude<Options[Key], undefined>;
}>;

/** Resolve and own a complete construction option record. */
export function resolveOptions(options: Options): ResolvedOptions {
  validateOptions(options);
  const values = options as Readonly<Record<string, unknown>>;
  const entries = Object.entries(OPTIONS).map(([key, definition]) => {
    const supplied = values[key];
    const value = supplied === undefined ? definition.default : supplied;
    const owned =
      (definition.kind === 'domain' || definition.kind === 'rgba') && value !== null
        ? Object.freeze([...(value as readonly number[])])
        : value;
    return [key, owned];
  });
  return Object.freeze(Object.fromEntries(entries)) as ResolvedOptions;
}

/** Copy a tuple the caller may still mutate; `null` stays `null`. */
export function own<T extends readonly number[]>(tuple: T | null): T | null {
  return tuple === null ? null : (Object.freeze([...tuple]) as unknown as T);
}

/**
 * Validate an option patch completely before any of it is applied.
 *
 * @throws TypeError or RangeError naming the first invalid option.
 */
export function validateOptions(options: Options): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('monitor options must be an object');
  }
  for (const [key, definition] of Object.entries(OPTIONS)) {
    const value = options[key as keyof Options];
    if (value === undefined) continue;
    validateOptionValue(key, definition, value);
  }
}

function validateOptionValue(key: string, definition: OptionDefinition, value: unknown): void {
  if (value === null && 'nullable' in definition && definition.nullable) return;
  switch (definition.kind) {
    case 'pool':
      if (typeof (value as Partial<DevicePool> | null)?.acquire !== 'function') {
        typeError(key, 'a device pool');
      }
      return;
    case 'colormap':
      if (typeof value !== 'function') typeError(key, 'a colormap function');
      return;
    case 'nonnegative':
      if (typeof value !== 'number') typeError(key, 'a number');
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`monitor option ${key} must be finite and nonnegative`);
      }
      return;
    case 'domain':
      validateDomain(value, `monitor option ${key}`);
      return;
    case 'rgba':
      if (!Array.isArray(value) || value.length !== 4) typeError(key, 'an RGBA tuple');
      for (const component of value) {
        if (typeof component !== 'number') typeError(key, 'an RGBA tuple');
        if (!Number.isFinite(component) || component < 0 || component > 1) {
          throw new RangeError(
            `monitor option ${key} RGBA components must be finite and in [0, 1]`,
          );
        }
      }
      return;
    default:
      definition satisfies never;
  }
}

function typeError(key: string, expected: string): never {
  throw new TypeError(`monitor option ${key} must be ${expected}`);
}
