import type { Data } from './materialized.js';
import type { FieldDefinition } from './schema.js';
import type { FieldInput } from './reader/types.js';

/** The definition of the field an input names: in `from` of `source`, in another source, or none for local values. */
export function fieldDefinition(
  source: Data,
  from: string,
  input: FieldInput,
): FieldDefinition | undefined {
  if (typeof input === 'string') return source.schema.types[from]?.fields[input];
  return 'source' in input ? input.source.schema.types[input.from]?.fields[input.field] : undefined;
}
