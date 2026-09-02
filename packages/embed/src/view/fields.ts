import type { Domain } from '@latkit/network';

import type { NetworkData, NetworkField } from '../data/types.js';

/** One field paired with its cached finite extent. */
export interface FieldEntry {
  readonly field: NetworkField;
  readonly extent: Domain | null;
}

/** Scope-preserving lookup metadata derived from one decoded network input. */
export interface FieldCatalog {
  readonly vertex: readonly FieldEntry[];
  readonly edge: readonly FieldEntry[];
  readonly byId: ReadonlyMap<string, FieldEntry>;
}

const cache = new WeakMap<NetworkData, FieldCatalog>();

/** Return the cached field catalog for decoded network data. */
export function fieldsFor(data: NetworkData): FieldCatalog {
  const cached = cache.get(data);
  if (cached) return cached;

  const vertex: FieldEntry[] = [];
  const edge: FieldEntry[] = [];
  const byId = new Map<string, FieldEntry>();

  for (const field of data.fields ?? []) {
    const entry: FieldEntry = { field, extent: finiteExtent(field.values) };
    byId.set(field.id, entry);
    (field.scope === 'vertex' ? vertex : edge).push(entry);
  }

  const fields: FieldCatalog = { vertex, edge, byId };
  cache.set(data, fields);
  return fields;
}

/** Return the finite `[min, max]` extent of values, or `null` when none exist. */
export function finiteExtent(values: Float32Array): Domain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? [min, max] : null;
}
