/**
 * HTML attributes derived from a controller's `OPTIONS` registry: every serializable option under
 * its kebab-case name, parsed by the registry's own validation kind.
 */

/** The part of an option definition the HTML boundary reads. */
export interface OptionDefinition {
  readonly kind: string;
  readonly default: unknown;
  readonly live: boolean;
  readonly values?: readonly (string | number)[];
}

/** One serializable option and its mechanically derived HTML attribute. */
export interface OptionAttribute<Key extends string = string> {
  readonly option: Key;
  readonly attribute: string;
  readonly definition: OptionDefinition;
}

/** Convert one camelCase public name to its exact HTML spelling. */
export function htmlName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Every option that can be spelled in HTML: functions and device pools cannot. */
export function optionAttributes<Key extends string>(
  registry: Readonly<Record<Key, OptionDefinition>>,
): readonly OptionAttribute<Key>[] {
  const entries = Object.entries(registry) as unknown as Array<readonly [Key, OptionDefinition]>;
  return Object.freeze(
    entries
      .filter(([, definition]) => definition.kind !== 'colormap' && definition.kind !== 'pool')
      .map(([option, definition]) =>
        Object.freeze({ option, attribute: htmlName(option), definition }),
      ),
  );
}

/** Parse one attribute string by its option kind; `undefined` when it cannot be read. */
export function parseOptionAttribute(definition: OptionDefinition, raw: string): unknown {
  switch (definition.kind) {
    case 'boolean':
      if (raw === '' || raw === 'true') return true;
      if (raw === 'false') return false;
      return undefined;
    case 'finite':
    case 'nonnegative':
      return decimal(raw.trim());
    case 'rgba': {
      const parts = tokens(raw);
      return parts.length === 4 ? parts.map(decimal) : undefined;
    }
    case 'domain':
      return decimalPair(raw) ?? undefined;
    case 'insets': {
      const parts = tokens(raw).map(decimal);
      return parts.length === 1 ? parts[0] : parts.length === 4 ? parts : undefined;
    }
    case 'enum':
      return definition.values?.every((value) => typeof value === 'number')
        ? decimal(raw.trim())
        : raw;
    default:
      return undefined;
  }
}

/** Parse a `"min max"` attribute; `undefined` for any other token count. */
export function decimalPair(value: string): [number, number] | undefined {
  const parts = tokens(value);
  return parts.length === 2 ? [decimal(parts[0]!), decimal(parts[1]!)] : undefined;
}

/** Whitespace-separated tokens of an attribute value. */
export function tokens(value: string): string[] {
  const trimmed = value.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

/** A strict decimal literal, or NaN. */
export function decimal(value: string): number {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number.NaN;
  return Number(value);
}
