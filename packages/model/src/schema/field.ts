import type { Data } from '../data/data.js';
import type { Schema } from './schema.js';
import type { FieldInput } from '../reader/types.js';

/** The definition of the field an input names: in `from` of `source`, in another source, or none for local values. */
export function fieldDefinition(
  source: Data,
  from: string,
  input: FieldInput,
): Schema.Field | undefined {
  if (typeof input === 'string') return source.schema.types[from]?.fields[input];
  return 'source' in input ? input.source.schema.types[input.from]?.fields[input.field] : undefined;
}
