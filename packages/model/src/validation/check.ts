import type { Problem } from '../types.js';

export type Path = readonly (string | number)[];
export const numeric = ['float32', 'float64', 'int32', 'uint32'];
export const kinds = ['rows', 'samples', 'envelope', 'endpoints', 'links', 'aggregate'];
export const own = (object: object, key: PropertyKey): boolean => Object.hasOwn(object, key);
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !ArrayBuffer.isView(value);

export class Check {
  readonly issues: Problem[] = [];
  issue(path: Path, message: string, code = 'invalid-input'): void {
    this.issues.push({ code, message, target: { kind: 'path', path } });
  }
  object(value: unknown, path: Path): Record<string, unknown> {
    if (record(value)) return value;
    this.issue(path, 'Expected an object.');
    return {};
  }
  array(value: unknown, path: Path): readonly unknown[] {
    if (Array.isArray(value)) return value as readonly unknown[];
    this.issue(path, 'Expected an array.');
    return [];
  }
  text(value: unknown, path: Path, empty = false): value is string {
    if (typeof value === 'string' && (empty || value.length > 0)) return true;
    this.issue(path, 'Expected a nonempty string.');
    return false;
  }
  integer(value: unknown, path: Path, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max)
      return true;
    this.issue(path, 'Expected an integer in [' + min + ', ' + max + '].');
    return false;
  }
  finite(value: unknown, path: Path): value is number {
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    this.issue(path, 'Expected a finite number.');
    return false;
  }
  enum(value: unknown, choices: readonly string[], path: Path): boolean {
    if (typeof value === 'string' && choices.includes(value)) return true;
    this.issue(path, 'Expected one of: ' + choices.join(', ') + '.');
    return false;
  }
  optional(
    object: Record<string, unknown>,
    key: string,
    check: (value: unknown, path: Path) => unknown,
    path: Path,
  ): void {
    if (own(object, key)) check(object[key], [...path, key]);
  }
  bool(value: unknown, path: Path): void {
    if (typeof value !== 'boolean') this.issue(path, 'Expected a boolean.');
  }
  strings(
    value: unknown,
    path: Path,
    choices?: readonly string[],
    nonempty = false,
  ): readonly string[] {
    const list = this.array(value, path);
    const result: string[] = [];
    for (const [i, item] of list.entries()) {
      if (this.text(item, [...path, i])) {
        if (result.includes(item)) this.issue([...path, i], 'Duplicate selection.');
        if (choices && !choices.includes(item)) this.issue([...path, i], 'Unknown selection.');
        result.push(item);
      }
    }
    if (nonempty && !list.length) this.issue(path, 'Selection must not be empty.');
    return result;
  }
}

export function bounds(c: Check, value: unknown, path: Path): void {
  const b = c.object(value, path);
  for (const key of ['lower', 'upper'])
    if (own(b, key)) {
      const edge = c.object(b[key], [...path, key]);
      c.finite(edge.value, [...path, key, 'value']);
      c.optional(edge, 'inclusive', c.bool.bind(c), [...path, key]);
    }
  if (
    record(b.lower) &&
    record(b.upper) &&
    typeof b.lower.value === 'number' &&
    typeof b.upper.value === 'number'
  ) {
    if (
      b.lower.value > b.upper.value ||
      (b.lower.value === b.upper.value &&
        (b.lower.inclusive === false || b.upper.inclusive === false))
    )
      c.issue(path, 'Bounds describe an empty interval.');
  }
}
