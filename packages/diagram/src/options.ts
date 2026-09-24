import { devices, type DevicePool } from '@latkit/gpu';
import { validateRgba, type Colormap, type RGBA } from '@latkit/model';

/**
 * What input does. `'edit'` adds drawing wires, moving blocks, and proposing deletions to
 * `'navigate'`, which moves the camera; `'inspect'` keeps hover, taps, and keyboard selection and
 * leaves the wheel and touch scrolling to the page; `'none'` installs no listeners at all.
 */
export type Interaction = 'edit' | 'navigate' | 'inspect' | 'none';

/**
 * Diagram options: the construction record and the live patch.
 *
 * @remarks
 * `devices` is read once at construction. Every other field seeds the initial view and can be
 * patched later with `Diagram.setOptions`; `OPTIONS` says which and carries each default. An
 * option marked nullable takes `null` to hand the decision back to the controller.
 */
export interface Options {
  /** Where `Diagram.attach` leases its device. @defaultValue the realm-wide pool from `@latkit/gpu`. */
  devices?: DevicePool;
  /** What input does. @defaultValue `'navigate'` */
  interaction?: Interaction;
  /**
   * Grid pitch in diagram units, which are CSS pixels only at zoom 1: the grid scales with the
   * view. Every block size, port pitch, and text size derives from it, so changing it re-sizes
   * and re-arranges the diagram. @defaultValue `8`
   */
  gridPitch?: number;
  /** Draw the dot grid. @defaultValue `true` */
  grid?: boolean;
  /** Snap drags, drops, and `toDiagram` to the grid. @defaultValue `true` */
  snap?: boolean;
  /**
   * How wires run: right-angle routes with trunks and junctions, or straight lines.
   * @defaultValue `'orthogonal'`
   */
  routing?: 'orthogonal' | 'straight';
  /** Draw text; it fades below a legible size either way. @defaultValue `true` */
  labels?: boolean;
  /** Draw an arrowhead where a wire enters a reader. @defaultValue `true` */
  arrows?: boolean;
  /** Draw a dot where a wire branches. @defaultValue `true` */
  junctions?: boolean;
  /**
   * Text font; block sizes and text runs assume a monospace advance of 0.6 em.
   * @defaultValue `'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'`
   */
  fontFamily?: string;
  /** Transfer function for `blockColor` and `netColor`. @defaultValue A neutral gray ramp. */
  colormap?: Colormap;
  /** Speed multiplier for dashes marching along `netFlow` nets. @defaultValue `1` */
  flowRate?: number;
  /**
   * Motion. `'auto'` follows `prefers-reduced-motion`; under reduced motion camera moves and
   * arrangements land at once, dashes stand still as chevrons, and removed blocks vanish without a
   * fade. @defaultValue `'auto'`
   */
  motion?: 'auto' | 'reduce' | 'full';
  /** Duration of eased camera moves, arrangements, and fades, in milliseconds. @defaultValue `300` */
  animationMs?: number;
  /**
   * Attach the keyboard map to the canvas: arrows pan, nudge, or step; plus and minus zoom; Home
   * fits; Tab walks the blocks; Enter opens; Escape cancels or clears; Delete proposes a deletion.
   * The canvas becomes focusable when it is not. @defaultValue `true`
   */
  keyboard?: boolean;
  /**
   * Whether a plain wheel zooms, or only a Ctrl or Meta wheel does while the page keeps scrolling.
   * @defaultValue `'zoom'`
   */
  wheel?: 'zoom' | 'modifier';
  /**
   * Pick radius for mouse hover, taps, and `hitTest`, in CSS pixels; touch uses at least 22.
   * @defaultValue `8`
   */
  pickRadiusPx?: number;
  /** Inset a part must clear before `reveal` leaves it in place, in CSS pixels. @defaultValue `48` */
  revealPaddingPx?: number;
  /**
   * Inset every fit keeps clear, in CSS pixels: one value for every side, or
   * `[top, right, bottom, left]`; `null` keeps the default margin. @defaultValue `null`
   */
  fitPaddingPx?: number | readonly [number, number, number, number] | null;
  /** Block fill without a `blockColor` channel. @defaultValue `[0.19, 0.2, 0.24, 1]` */
  blockBaseColor?: RGBA;
  /** Block and group outlines. @defaultValue `[0.5, 0.53, 0.6, 1]` */
  outlineColor?: RGBA;
  /** Wire color without a `netColor` channel. @defaultValue `[0.62, 0.66, 0.72, 1]` */
  netBaseColor?: RGBA;
  /** Text color. @defaultValue `[0.9, 0.91, 0.93, 1]` */
  textColor?: RGBA;
  /** Grid dot color. @defaultValue `[0.55, 0.58, 0.65, 0.35]` */
  gridColor?: RGBA;
  /** Group frame fill. @defaultValue `[0.55, 0.58, 0.65, 0.08]` */
  groupColor?: RGBA;
  /** Hover highlight. @defaultValue `[0.72, 0.28, 0.18, 1]` */
  hoverColor?: RGBA;
  /** Selection highlight, marquee, and wire preview. @defaultValue `[0.72, 0.28, 0.18, 1]` */
  selectedColor?: RGBA;
  /** Port colors by `portKind`, cycling; at most 8. @defaultValue signal blue, then bus amber */
  portColors?: readonly RGBA[];
  /**
   * Status colors: a `blockStatus` or `portStatus` of `k > 0` uses entry `k - 1`, clamped to the
   * last; at most 4. @defaultValue warning amber, then error red
   */
  statusColors?: readonly RGBA[];
}

/** How wires run. */
export type Routing = NonNullable<Options['routing']>;

/** A CSS-pixel inset: one value for every side, or `[top, right, bottom, left]`. */
export type Insets = number | readonly [number, number, number, number];

/**
 * Validation kind, default, whether `Diagram.setOptions` accepts the option live, and whether
 * `null` is a value.
 */
export type OptionDefinition =
  | { readonly kind: 'boolean'; readonly default: boolean; readonly live: true }
  | { readonly kind: 'positive' | 'nonnegative'; readonly default: number; readonly live: true }
  | { readonly kind: 'rgba'; readonly default: RGBA; readonly live: true }
  | {
      readonly kind: 'palette';
      readonly default: readonly RGBA[];
      readonly max: number;
      readonly live: true;
    }
  | {
      readonly kind: 'insets';
      readonly default: Insets | null;
      readonly live: true;
      readonly nullable: true;
    }
  | {
      readonly kind: 'enum';
      readonly values: readonly string[];
      readonly default: string;
      readonly live: true;
    }
  | { readonly kind: 'colormap'; readonly default: Colormap; readonly live: true }
  | { readonly kind: 'font'; readonly default: string; readonly live: true }
  | { readonly kind: 'pool'; readonly default: DevicePool; readonly live: false };

/** The neutral transfer function before a consumer supplies a colormap. */
const neutralColormap: Colormap = Object.freeze((t: number) => [t, t, t] as const);

/** Freeze a tuple default before exposing it through public metadata. */
function tuple<T extends readonly number[]>(...values: T): Readonly<T> {
  return Object.freeze(values);
}

/** Freeze a palette default, entries and all. */
function palette(...entries: readonly RGBA[]): readonly RGBA[] {
  return Object.freeze(entries.map((entry) => Object.freeze([...entry]) as RGBA));
}

/** Freeze an enumerated value list before exposing it through public metadata. */
function values<const T extends readonly string[]>(...entries: T): T {
  return Object.freeze(entries) as T;
}

const definitions = {
  devices: { kind: 'pool', default: devices, live: false },
  interaction: {
    kind: 'enum',
    values: values('edit', 'navigate', 'inspect', 'none'),
    default: 'navigate',
    live: true,
  },
  gridPitch: { kind: 'positive', default: 8, live: true },
  grid: { kind: 'boolean', default: true, live: true },
  snap: { kind: 'boolean', default: true, live: true },
  routing: {
    kind: 'enum',
    values: values('orthogonal', 'straight'),
    default: 'orthogonal',
    live: true,
  },
  labels: { kind: 'boolean', default: true, live: true },
  arrows: { kind: 'boolean', default: true, live: true },
  junctions: { kind: 'boolean', default: true, live: true },
  fontFamily: {
    kind: 'font',
    default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    live: true,
  },
  colormap: { kind: 'colormap', default: neutralColormap, live: true },
  flowRate: { kind: 'nonnegative', default: 1, live: true },
  motion: { kind: 'enum', values: values('auto', 'reduce', 'full'), default: 'auto', live: true },
  animationMs: { kind: 'nonnegative', default: 300, live: true },
  keyboard: { kind: 'boolean', default: true, live: true },
  wheel: { kind: 'enum', values: values('zoom', 'modifier'), default: 'zoom', live: true },
  pickRadiusPx: { kind: 'nonnegative', default: 8, live: true },
  revealPaddingPx: { kind: 'nonnegative', default: 48, live: true },
  fitPaddingPx: { kind: 'insets', default: null, live: true, nullable: true },
  blockBaseColor: { kind: 'rgba', default: tuple(0.19, 0.2, 0.24, 1), live: true },
  outlineColor: { kind: 'rgba', default: tuple(0.5, 0.53, 0.6, 1), live: true },
  netBaseColor: { kind: 'rgba', default: tuple(0.62, 0.66, 0.72, 1), live: true },
  textColor: { kind: 'rgba', default: tuple(0.9, 0.91, 0.93, 1), live: true },
  gridColor: { kind: 'rgba', default: tuple(0.55, 0.58, 0.65, 0.35), live: true },
  groupColor: { kind: 'rgba', default: tuple(0.55, 0.58, 0.65, 0.08), live: true },
  hoverColor: { kind: 'rgba', default: tuple(0.72, 0.28, 0.18, 1), live: true },
  selectedColor: { kind: 'rgba', default: tuple(0.72, 0.28, 0.18, 1), live: true },
  portColors: {
    kind: 'palette',
    default: palette([0.45, 0.7, 0.95, 1], [0.93, 0.72, 0.3, 1]),
    max: 8,
    live: true,
  },
  statusColors: {
    kind: 'palette',
    default: palette([0.96, 0.7, 0.2, 1], [0.92, 0.3, 0.28, 1]),
    max: 4,
    live: true,
  },
} as const satisfies Record<keyof Required<Options>, OptionDefinition>;

for (const definition of Object.values(definitions)) Object.freeze(definition);

/** Every option: its validation kind, default, and whether it is accepted live. */
export const OPTIONS: Readonly<typeof definitions> = Object.freeze(definitions);

/** Fully resolved diagram options: every field present, arrays owned and frozen. */
export type ResolvedOptions = Readonly<Required<Options>>;

/** Build the default record mechanically from the canonical definitions. */
function resolveDefaults(): ResolvedOptions {
  const entries = Object.entries(OPTIONS).map(([key, definition]) => [key, definition.default]);
  return Object.freeze(Object.fromEntries(entries)) as ResolvedOptions;
}

/** Deeply immutable resolved defaults used by the diagram itself. */
export const DEFAULT_OPTIONS = resolveDefaults();

/**
 * Validate and own a complete option record: defaults fill what is missing, and every tuple and
 * palette is copied and frozen so a caller mutating its arrays later changes nothing.
 *
 * @throws TypeError or RangeError naming the first invalid option.
 */
export function resolveOptions(
  options: Options,
  base: ResolvedOptions = DEFAULT_OPTIONS,
): ResolvedOptions {
  validateOptions(options);
  const supplied = options as Readonly<Record<string, unknown>>;
  const current = base as Readonly<Record<string, unknown>>;
  const entries = Object.keys(OPTIONS).map((key) => {
    const value = supplied[key];
    return [key, value === undefined ? current[key] : own(value)];
  });
  return Object.freeze(Object.fromEntries(entries)) as ResolvedOptions;
}

/** A frozen copy of an array value, one level into palettes; anything else as is. */
function own(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return Object.freeze(
    (value as readonly unknown[]).map((entry) =>
      Array.isArray(entry) ? Object.freeze([...(entry as readonly number[])]) : entry,
    ),
  );
}

/**
 * Validate an option patch completely before any of it is applied.
 *
 * @throws TypeError or RangeError naming the first invalid option.
 */
export function validateOptions(options: Options): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('diagram options must be an object');
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
    case 'positive':
      validateNumber(key, value);
      if ((value as number) <= 0) throw new RangeError(`diagram option ${key} must be positive`);
      return;
    case 'nonnegative':
      validateNumber(key, value);
      if ((value as number) < 0) {
        throw new RangeError(`diagram option ${key} must be nonnegative`);
      }
      return;
    case 'rgba':
      validateRgba(value, `diagram option ${key}`);
      return;
    case 'palette': {
      if (!Array.isArray(value) || value.length === 0 || value.length > definition.max) {
        typeError(key, `an array of 1 to ${definition.max} RGBA tuples`);
      }
      (value as readonly unknown[]).forEach((entry, index) =>
        validateRgba(entry, `diagram option ${key}[${index}]`),
      );
      return;
    }
    case 'insets': {
      const sides = typeof value === 'number' ? [value] : value;
      if (!Array.isArray(sides) || (sides.length !== 1 && sides.length !== 4)) {
        typeError(key, 'a number or [top, right, bottom, left]');
      }
      for (const side of sides as readonly unknown[]) {
        validateNumber(key, side);
        if ((side as number) < 0) {
          throw new RangeError(`diagram option ${key} must be nonnegative`);
        }
      }
      return;
    }
    case 'enum':
      if (!definition.values.includes(value as string)) {
        typeError(key, `one of ${definition.values.join(', ')}`);
      }
      return;
    case 'colormap':
      if (typeof value !== 'function') typeError(key, 'a colormap function');
      return;
    case 'font':
      if (typeof value !== 'string' || value.trim() === '') typeError(key, 'a non-empty string');
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

/** A finite number, or throw naming the option. */
function validateNumber(key: string, value: unknown): void {
  if (typeof value !== 'number') typeError(key, 'a number');
  if (!Number.isFinite(value)) throw new RangeError(`diagram option ${key} must be finite`);
}

function typeError(key: string, expected: string): never {
  throw new TypeError(`diagram option ${key} must be ${expected}`);
}
