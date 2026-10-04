import { samePages, sameIndex, type Data, type TypeDefinition } from '@latkit/model';

/**
 * Whether two Data values number the same rows, under the same ids, and hold the same values in
 * the fields `fields` names for each type, whatever their identity: a value republished unchanged
 * reads as the same, so a view rebuilds only what its data changed.
 */
export function sameValues(
  a: Data,
  b: Data,
  fields: (type: string, definition: TypeDefinition) => readonly string[],
): boolean {
  if (a === b) return true;
  const types = Object.keys(a.tables);
  if (a.schema !== b.schema || types.length !== Object.keys(b.tables).length) return false;
  for (const type of types) {
    const x = a.tables[type],
      y = b.tables[type];
    if (!y || !sameIndex(x.index, y.index) || !samePages(x.ids, y.ids)) return false;
    if (
      x.rows !== y.rows &&
      (x.rows.kind !== 'range' ||
        y.rows.kind !== 'range' ||
        x.rows.offset !== y.rows.offset ||
        x.rows.count !== y.rows.count)
    )
      return false;
    for (const field of fields(type, a.schema.types[type])) {
      const before = x.fields[field],
        after = y.fields[field];
      if (before !== after && (!before || !after || !samePages(before, after))) return false;
    }
  }
  return true;
}
