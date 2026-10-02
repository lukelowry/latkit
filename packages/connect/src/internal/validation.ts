import { failure } from './errors.js';
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('invalid-input', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : record(value);
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length)
    throw failure('invalid-input', 'Expected nonempty text.');
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw failure('invalid-input', 'Expected an array.');
  return value as unknown[];
}
export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
