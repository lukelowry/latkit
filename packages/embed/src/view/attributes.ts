import {
  CHANNEL_DEFINITIONS,
  DEFAULT_OPTIONS,
  OPTION_DEFINITIONS,
  PROJECTION_MODES,
  channelNormalizes,
  type Channel,
  type ChannelDefinition,
  type ChannelRange,
  type ConstructionOption,
  type FocusEndpointMode,
  type NormalizedChannel,
  type OptionDefinition,
  type Options,
  type ProjectionMode,
  type RGBA,
  type RuntimeOption,
  validateChannelRange,
  validateOption,
} from '@latkit/network';

/** Convert one Network camelCase public name to its exact HTML spelling. */
export type HtmlName<Name extends string> = Name extends `${infer Head}${infer Tail}`
  ? Head extends Lowercase<Head>
    ? `${Head}${HtmlName<Tail>}`
    : `-${Lowercase<Head>}${HtmlName<Tail>}`
  : Name;

/** Convert one Network camelCase public name to its exact HTML spelling. */
export function htmlName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

type AttributeOption = Exclude<keyof Options, 'colormap'>;

/** Serializable option keys selected by Network's construction lifecycle metadata. */
export type ConstructionAttributeOption = Extract<AttributeOption, ConstructionOption>;

/** Serializable option keys selected by Network's runtime lifecycle metadata. */
export type RuntimeAttributeOption = Extract<AttributeOption, RuntimeOption>;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type _ConstructionOptionsAreExactlyMsaa = Expect<Equal<ConstructionAttributeOption, 'msaa'>>;
type _ColormapRemainsRuntime = Expect<Equal<Extract<RuntimeOption, 'colormap'>, 'colormap'>>;

/** One serializable Network option and its mechanically derived HTML attribute. */
export interface OptionAttribute {
  readonly option: AttributeOption;
  readonly attribute: HtmlName<AttributeOption>;
  readonly definition: OptionDefinition;
}

/** One canonical channel and its mechanically derived HTML surfaces. */
export type ChannelAttributeDefinition = ChannelDefinition & {
  readonly attribute: HtmlName<Channel>;
  readonly domainAttribute: `${HtmlName<Channel>}-domain` | null;
  readonly rangeAttribute: `${HtmlName<Channel>}-range` | null;
};

/** HTML field-binding name for a canonical Network channel. */
export type ChannelAttribute = HtmlName<Channel>;

export type { NormalizedChannel };

/** Network channels rendered through the shared colormap. */
export type ColormapChannel = Extract<ChannelDefinition, { readonly map: 'colormap' }>['key'];

/** HTML legend token for a colormap-mapped Network channel. */
export type LegendControl = `${HtmlName<ColormapChannel>}-legend`;

/** Independently selectable fixed Embed chrome. */
export type FixedControl = 'caption' | 'projection' | 'fit' | 'zoom' | 'colormap';

/** One concrete chrome feature after group expansion. */
export type Control = FixedControl | ChannelAttribute | LegendControl;

/** One recoverable author-configuration problem. */
export interface ViewWarning {
  readonly key: string;
  readonly message: string;
}

/** Parsed control grammar before automatic meaningfulness is resolved. */
export type ControlSelection =
  | { readonly mode: 'auto' }
  | { readonly mode: 'none' }
  | { readonly mode: 'explicit'; readonly controls: ReadonlySet<Control> };

const optionEntries = Object.entries(OPTION_DEFINITIONS) as Array<
  readonly [keyof Options, OptionDefinition]
>;

/** Every serializable Network option attribute, derived from Network metadata. */
export const OPTION_ATTRIBUTES: readonly OptionAttribute[] = Object.freeze(
  optionEntries
    .filter(
      (entry): entry is readonly [AttributeOption, OptionDefinition] => entry[0] !== 'colormap',
    )
    .map(([option, definition]) =>
      Object.freeze({
        option,
        attribute: htmlName(option) as HtmlName<AttributeOption>,
        definition,
      }),
    ),
);

/** Every channel-facing HTML surface, derived from Network metadata. */
export const CHANNEL_ATTRIBUTES: readonly ChannelAttributeDefinition[] = Object.freeze(
  CHANNEL_DEFINITIONS.map((definition) => {
    const attribute = htmlName(definition.key) as HtmlName<Channel>;
    return Object.freeze({
      ...definition,
      attribute,
      domainAttribute: channelNormalizes(definition) ? (`${attribute}-domain` as const) : null,
      rangeAttribute: definition.map === 'height' ? (`${attribute}-range` as const) : null,
    }) as ChannelAttributeDefinition;
  }),
);

/** Normalized channels in canonical Network order. */
export const NORMALIZED_CHANNEL_NAMES: readonly NormalizedChannel[] = Object.freeze(
  CHANNEL_DEFINITIONS.filter(channelNormalizes).map((definition) => definition.key),
);

/** Fast derived lookups; these contain no independently authored vocabulary. */
export const OPTION_BY_ATTRIBUTE: ReadonlyMap<string, OptionAttribute> = new Map(
  OPTION_ATTRIBUTES.map((entry) => [entry.attribute, entry] as const),
);
export const CHANNEL_BY_KEY = new Map(
  CHANNEL_ATTRIBUTES.map((entry) => [entry.key, entry] as const),
);
export const CHANNEL_BY_ATTRIBUTE: ReadonlyMap<string, ChannelAttributeDefinition> = new Map(
  CHANNEL_ATTRIBUTES.map((entry) => [entry.attribute, entry] as const),
);

const FIXED_CONTROLS = ['caption', 'projection', 'fit', 'zoom', 'colormap'] as const;
const CHANNEL_CONTROLS = CHANNEL_ATTRIBUTES.map((entry) => entry.attribute);
const LEGEND_CONTROLS = CHANNEL_ATTRIBUTES.filter((entry) => entry.map === 'colormap').map(
  (entry) => `${entry.attribute}-legend` as LegendControl,
);

/** Every concrete control token accepted in an explicit list. */
export const CONTROL_NAMES: readonly Control[] = Object.freeze([
  ...FIXED_CONTROLS,
  ...CHANNEL_CONTROLS,
  ...LEGEND_CONTROLS,
]);

const CONTROLS = new Set<string>(CONTROL_NAMES);
const PROJECTIONS = new Set<string>(PROJECTION_MODES);
const INVALID_OPTION = Symbol('invalid option attribute');

/** Every live non-source attribute consumed by resolved view state. */
export const VIEW_ATTRIBUTES: readonly string[] = Object.freeze(
  unique([
    'projection',
    'colormap',
    'border-source',
    'controls',
    ...OPTION_ATTRIBUTES.map((entry) => entry.attribute),
    ...CHANNEL_ATTRIBUTES.flatMap((entry) => {
      const names: string[] = [entry.attribute];
      if (entry.domainAttribute) names.push(entry.domainAttribute);
      if (entry.rangeAttribute) names.push(entry.rangeAttribute);
      return names;
    }),
  ]),
);

/** Return the generated channel metadata for a public channel or throw. */
export function channelAttribute(channel: Channel): ChannelAttributeDefinition {
  const definition = CHANNEL_BY_KEY.get(channel);
  if (!definition) throw new TypeError(`Unknown network channel ${quote(String(channel))}`);
  return definition;
}

/** Validate a projection mode through Network's canonical tuple. */
export function assertProjectionMode(value: unknown): asserts value is ProjectionMode {
  if (typeof value !== 'string' || !PROJECTIONS.has(value)) {
    throw new TypeError(`Unknown network projection ${quote(String(value))}`);
  }
}

/** Validate a Float32Array across browser realms. */
export function assertFloat32Array(value: unknown, name: string): asserts value is Float32Array {
  if (Object.prototype.toString.call(value) !== '[object Float32Array]') {
    throw new TypeError(`${name} must be a Float32Array`);
  }
}

/** Validate and copy a public channel range. */
export function checkedRange(value: unknown, name: string): ChannelRange {
  validateChannelRange(value, name);
  return [value[0], value[1]];
}

/** Parse one range attribute, returning null for absent or invalid values. */
export function parseRange(
  attribute: string,
  raw: string | null,
  warnings: ViewWarning[],
): ChannelRange | null {
  if (raw === null) return null;
  const parts = tokens(raw);
  if (parts.length === 2) {
    const values = parts.map(decimal);
    try {
      validateChannelRange(values, attribute);
      return [values[0]!, values[1]!];
    } catch {
      // Invalid author values warn and leave the binding's base range active.
    }
  }
  warnings.push(
    warning(attribute, raw, `Invalid ${attribute} ${quote(raw)}; ignoring the override.`),
  );
  return null;
}

/** Serialize a validated range to a stable space-separated attribute value. */
export function serializeRange(value: ChannelRange, name = 'range'): string {
  const checked = checkedRange(value, name);
  return `${checked[0]} ${checked[1]}`;
}

/** Parse all control tokens, expanding groups without creating alias features. */
export function parseControls(raw: string | null, warnings: ViewWarning[]): ControlSelection {
  if (raw === null || raw.trim() === '') return { mode: 'auto' };

  const values = [...new Set(tokens(raw))];
  const concrete = values.filter(
    (value) =>
      CONTROLS.has(value) || value === 'navigation' || value === 'channels' || value === 'legends',
  );
  const unknown = values.filter(
    (value) =>
      !CONTROLS.has(value) &&
      value !== 'navigation' &&
      value !== 'channels' &&
      value !== 'legends' &&
      value !== 'none' &&
      value !== 'auto',
  );
  const diagnostics: string[] = [];
  if (unknown.length > 0) {
    diagnostics.push(`Unknown controls ${unknown.map(quote).join(', ')}; ignoring them.`);
  }

  let mode: 'none' | 'auto' | null = null;
  if (values.includes('none')) {
    mode = 'none';
    if (concrete.length > 0 || values.includes('auto')) {
      diagnostics.push(`${quote('none')} cannot be combined with other controls; using none.`);
    }
  } else if (values.includes('auto')) {
    mode = 'auto';
    if (concrete.length > 0) {
      diagnostics.push(`${quote('auto')} cannot be combined with other controls; using auto.`);
    }
  }

  if (diagnostics.length > 0) {
    warnings.push(warning('controls', raw, diagnostics.join(' ')));
  }
  if (mode) return { mode };

  const controls = new Set<Control>();
  for (const value of concrete) {
    if (value === 'navigation') {
      controls.add('fit');
      controls.add('zoom');
    } else if (value === 'channels') {
      for (const control of CHANNEL_CONTROLS) controls.add(control);
    } else if (value === 'legends') {
      for (const control of LEGEND_CONTROLS) controls.add(control);
    } else {
      controls.add(value as Control);
    }
  }
  return { mode: 'explicit', controls };
}

/** Resolve one option attribute through the Network-owned validation kind/default. */
export function parseOptionAttribute(
  entry: OptionAttribute,
  raw: string | null,
  warnings: ViewWarning[],
): unknown {
  const fallback = DEFAULT_OPTIONS[entry.option];
  if (raw === null) return fallback;

  let value: unknown = INVALID_OPTION;
  switch (entry.definition.kind) {
    case 'boolean':
      if (raw === '' || raw === 'true') value = true;
      else if (raw === 'false') value = false;
      break;
    case 'finite':
    case 'nonnegative': {
      value = decimal(raw.trim());
      break;
    }
    case 'rgba': {
      const parts = tokens(raw);
      if (parts.length === 4) {
        const rgba = parts.map(decimal);
        value = rgba;
      }
      break;
    }
    case 'focus-endpoint':
      value = raw;
      break;
    case 'msaa':
      if (raw === '1' || raw === '4') value = Number(raw) as 1 | 4;
      break;
    case 'colormap':
      break;
    default:
      entry.definition satisfies never;
  }

  if (value !== INVALID_OPTION) {
    try {
      validateOption(entry.option, value);
      return value;
    } catch {
      // Invalid author values warn and resolve to the Network-owned default.
    }
  }
  warnings.push(
    warning(
      entry.attribute,
      raw,
      `Invalid ${entry.attribute} ${quote(raw)}; using the Network default.`,
    ),
  );
  return fallback;
}

/** Validate and serialize one JavaScript option value through Network metadata. */
export function serializeOption(entry: OptionAttribute, value: unknown): string {
  validateOption(entry.option, value);
  switch (entry.definition.kind) {
    case 'boolean':
      return String(value);
    case 'finite':
    case 'nonnegative':
      return String(value);
    case 'rgba':
      return (value as RGBA).join(' ');
    case 'focus-endpoint':
      return value as FocusEndpointMode;
    case 'msaa':
      return String(value);
    case 'colormap':
      throw new TypeError('colormap is not serializable');
    default:
      entry.definition satisfies never;
      throw new TypeError('Unknown option definition');
  }
}

/** Make a stable warning key for one attribute/value pair. */
export function warning(attribute: string, value: string, message: string): ViewWarning {
  return { key: `${attribute}\u0000${value}`, message };
}

/** Quote an author value in warning text. */
export function quote(value: string): string {
  return JSON.stringify(value);
}

function tokens(value: string): string[] {
  const trimmed = value.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

function decimal(value: string): number {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number.NaN;
  return Number(value);
}

function unique(values: readonly string[]): string[] {
  const result = [...new Set(values)];
  if (result.length !== values.length) throw new Error('@latkit/embed: duplicate view attribute');
  return result;
}
