import { failure } from '@latkit/model';

export function integer(
  value: number,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw failure('invalid-input', `${label} must be an integer in [${minimum}, ${maximum}]`);
  return value;
}

export function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
