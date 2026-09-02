import {
  CHANNELS,
  OPTIONS,
  PROJECTIONS,
  validateOptions,
  type Channel,
  type Domain,
  type Options,
  type Projection,
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

/** One Network option's validation kind, default, and live acceptance. */
export type OptionDefinition = (typeof OPTIONS)[keyof typeof OPTIONS];

/** One Network channel's scope, shader map, label, and normalization. */
export type ChannelDefinition = (typeof CHANNELS)[Channel];

/** Normalized RGBA tuple as Network's color options accept it. */
export type RGBA = NonNullable<Options['baseColor']>;

/** Endpoint highlight modes accepted by Network's `focusEndpointMode`. */
export type FocusEndpointMode = NonNullable<Options['focusEndpointMode']>;

type AttributeOption = Exclude<keyof Options, 'colormap'>;

/** Option keys selected by whether Network accepts them live. */
type OptionKeyByLive<Live extends boolean> = {
  [Key in keyof typeof OPTIONS]: (typeof OPTIONS)[Key]['live'] extends Live ? Key : never;
}[keyof typeof OPTIONS];

/** Serializable option keys Network reads once at construction. */
export type ConstructionAttributeOption = Extract<AttributeOption, OptionKeyByLive<false>>;

/** Serializable option keys Network accepts as live patches. */
export type RuntimeAttributeOption = Extract<AttributeOption, OptionKeyByLive<true>>;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type _ConstructionOptionsAreExactlyMsaa = Expect<Equal<ConstructionAttributeOption, 'msaa'>>;
type _ColormapRemainsLive = Expect<Equal<Extract<OptionKeyByLive<true>, 'colormap'>, 'colormap'>>;

/** One serializable Network option and its mechanically derived HTML attribute. */
export interface OptionAttribute {
  readonly option: AttributeOption;
  readonly attribute: HtmlName<AttributeOption>;
  readonly definition: OptionDefinition;
}

/** One canonical channel and its mechanically derived HTML surfaces. */
export type ChannelAttributeDefinition = ChannelDefinition & {
  readonly key: Channel;
  readonly attribute: HtmlName<Channel>;
  readonly domainAttribute: `${HtmlName<Channel>}-domain` | null;
};

/** HTML field-binding name for a canonical Network channel. */
export type ChannelAttribute = HtmlName<Channel>;

/** Channels whose values pass through an input domain. */
export type NormalizedChannel = {
  [Key in Channel]: (typeof CHANNELS)[Key]['normalized'] extends true ? Key : never;
}[Channel];

/** Network channels rendered through the shared colormap. */
export type ColormapChannel = {
  [Key in Channel]: (typeof CHANNELS)[Key]['map'] extends 'colormap' ? Key : never;
}[Channel];

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

const optionEntries = Object.entries(OPTIONS) as Array<readonly [keyof Options, OptionDefinition]>;

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

const channelEntries = Object.entries(CHANNELS) as Array<readonly [Channel, ChannelDefinition]>;

/** Every channel-facing HTML surface, derived from Network metadata in canonical order. */
export const CHANNEL_ATTRIBUTES: readonly ChannelAttributeDefinition[] = Object.freeze(
  channelEntries.map(([key, definition]) => {
    const attribute = htmlName(key) as HtmlName<Channel>;
    return Object.freeze({
      ...definition,
      key,
      attribute,
      domainAttribute: definition.normalized ? (`${attribute}-domain` as const) : null,
    }) as ChannelAttributeDefinition;
  }),
);

/** Normalized channels in canonical Network order. */
export const NORMALIZED_CHANNEL_NAMES: readonly NormalizedChannel[] = Object.freeze(
  CHANNEL_ATTRIBUTES.filter((entry) => entry.normalized).map(
    (entry) => entry.key as NormalizedChannel,
  ),
);

/** Fast derived lookups; these contain no independently authored vocabulary. */
export const OPTION_BY_ATTRIBUTE: ReadonlyMap<string, OptionAttribute> = new Map(
  OPTION_ATTRIBUTES.map((entry) => [entry.attribute, entry] as const),
);
export const CHANNEL_BY_KEY: ReadonlyMap<Channel, ChannelAttributeDefinition> = new Map(
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
const PROJECTION_NAMES = new Set<string>(PROJECTIONS);
const INVALID_OPTION = Symbol('invalid option attribute');

/** Every live non-source attribute consumed by resolved view state. */
export const VIEW_ATTRIBUTES: readonly string[] = Object.freeze(
  unique([
    'projection',
    'colormap',
    'border-source',
    'controls',
    ...OPTION_ATTRIBUTES.map((entry) => entry.attribute),
    ...CHANNEL_ATTRIBUTES.flatMap((entry) =>
      entry.domainAttribute ? [entry.attribute, entry.domainAttribute] : [entry.attribute],
    ),
  ]),
);

/** Return the generated channel metadata for a public channel or throw. */
export function channelAttribute(channel: Channel): ChannelAttributeDefinition {
  const definition = CHANNEL_BY_KEY.get(channel);
  if (!definition) throw new TypeError(`Unknown network channel ${quote(String(channel))}`);
  return definition;
}

/** Validate a projection through Network's canonical tuple. */
export function assertProjection(value: unknown): asserts value is Projection {
  if (typeof value !== 'string' || !PROJECTION_NAMES.has(value)) {
    throw new TypeError(`Unknown network projection ${quote(String(value))}`);
  }
}

/** Validate a Float32Array across browser realms. */
export function assertFloat32Array(value: unknown, name: string): asserts value is Float32Array {
  if (Object.prototype.toString.call(value) !== '[object Float32Array]') {
    throw new TypeError(`${name} must be a Float32Array`);
  }
}

/** Validate a `[min, max]` domain with Network's rules without retaining it. */
export function validateDomain(value: unknown, name: string): asserts value is Domain {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${name} must contain exactly two numbers`);
  }
  const [minimum, maximum] = value as readonly unknown[];
  if (typeof minimum !== 'number' || typeof maximum !== 'number') {
    throw new TypeError(`${name} must contain exactly two numbers`);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new RangeError(`${name} values must be finite`);
  }
  if (minimum > maximum) throw new RangeError(`${name} minimum must not exceed its maximum`);
}

/** Validate and copy a public channel domain. */
export function checkedDomain(value: unknown, name: string): Domain {
  validateDomain(value, name);
  return [value[0], value[1]];
}

/** Parse one domain attribute, returning null for absent or invalid values. */
export function parseDomain(
  attribute: string,
  raw: string | null,
  warnings: ViewWarning[],
): Domain | null {
  if (raw === null) return null;
  const parsed = decimalPair(raw);
  if (parsed) {
    try {
      return checkedDomain(parsed, attribute);
    } catch {
      // Invalid author values warn and leave the binding's base domain active.
    }
  }
  warnings.push(
    warning(attribute, raw, `Invalid ${attribute} ${quote(raw)}; ignoring the override.`),
  );
  return null;
}

/** Serialize a validated domain to a stable space-separated attribute value. */
export function serializeDomain(value: Domain, name = 'domain'): string {
  const checked = checkedDomain(value, name);
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
  const fallback: unknown = entry.definition.default;
  if (raw === null) return fallback;

  let value: unknown = INVALID_OPTION;
  switch (entry.definition.kind) {
    case 'boolean':
      if (raw === '' || raw === 'true') value = true;
      else if (raw === 'false') value = false;
      break;
    case 'finite':
    case 'nonnegative':
      value = decimal(raw.trim());
      break;
    case 'rgba': {
      const parts = tokens(raw);
      if (parts.length === 4) value = parts.map(decimal);
      break;
    }
    case 'domain':
      value = decimalPair(raw) ?? INVALID_OPTION;
      break;
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
      validateOptions({ [entry.option]: value });
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
  validateOptions({ [entry.option]: value });
  switch (entry.definition.kind) {
    case 'boolean':
    case 'finite':
    case 'nonnegative':
    case 'msaa':
      return String(value);
    case 'rgba':
      return (value as RGBA).join(' ');
    case 'domain':
      return (value as Domain).join(' ');
    case 'focus-endpoint':
      return value as FocusEndpointMode;
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

/** Parse exactly two strict decimals, or null for any other token count. */
function decimalPair(value: string): [number, number] | null {
  const parts = tokens(value);
  return parts.length === 2 ? [decimal(parts[0]!), decimal(parts[1]!)] : null;
}

function unique(values: readonly string[]): string[] {
  const result = [...new Set(values)];
  if (result.length !== values.length) throw new Error('@latkit/embed: duplicate view attribute');
  return result;
}
