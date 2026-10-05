import type { Data } from './materialized.js';
import type { FieldDefinition, Space, TypeDefinition } from './schema.js';
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
/** Where a view draws a type by default: its first vector field in one of `spaces`, tried in order. */
export function positionField(
  definition: TypeDefinition,
  spaces: readonly Space[],
): string | undefined {
  for (const space of spaces)
    for (const [name, field] of Object.entries(definition.fields))
      if (field.space === space && typeof field.type === 'object') return name;
  return undefined;
}
