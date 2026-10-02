import type { Schema } from '../schema.js';
import type { Problem } from '../types.js';
import { record } from './check.js';
import { validateQuery } from './query.js';

/** Validate field/row demand without pretending it is a historical query. */
export function validateSelection(schema: Schema, value: unknown): readonly Problem[] {
  if (!record(value)) return [{ code: 'invalid-input', message: 'Expected a field selection.' }];
  const fields =
    typeof value.from === 'string' && Object.hasOwn(schema.types, value.from)
      ? schema.types[value.from].fields
      : undefined;
  const sampled =
    Array.isArray(value.select) &&
    value.select.some(
      (name: unknown) =>
        typeof name === 'string' && fields && Object.hasOwn(fields, name) && fields[name].sampled,
    );
  return validateQuery(schema, { ...value, kind: 'rows', ...(sampled ? { at: 0 } : {}) });
}
