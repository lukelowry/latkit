import type { Schema } from '../schema.js';
import type { Problem } from '../types.js';
import type { QueryOptions, Query } from '../query.js';
import { Check, record } from './check.js';
import { validateBlock } from './block.js';
import { validateQuery } from './query.js';

/** Validate a columnar batch directly. Delivery size is an operation option, not schema meaning. */
export function validateBatch(
  schema: Schema,
  value: unknown,
  options: QueryOptions = {},
): readonly Problem[] {
  const c = new Check();
  const batch = c.object(value, []);
  c.enum(batch.kind, ['rows', 'samples'], ['kind']);
  if (!record(batch.columns) || !record(batch.index))
    return [...c.issues, { code: 'invalid-input', message: 'Missing columns or row identity.' }];
  const query =
    batch.kind === 'samples'
      ? {
          kind: 'samples',
          from: batch.index.type,
          select: Object.keys(batch.columns),
          window: {
            kind: 'frames',
            offset: batch.firstFrame,
            count: batch.coordinates instanceof Float64Array ? batch.coordinates.length : 0,
          },
        }
      : {
          kind: 'rows',
          from: batch.index.type,
          select: Object.keys(batch.columns),
          ...(batch.ids ? { ids: true } : {}),
        };
  const issues = validateQuery(schema, query);
  if (issues.length) return [...c.issues, ...issues];
  return [
    ...c.issues,
    ...validateBlock(schema, query as Query, { ...batch, rowOffset: 0 }, options),
  ];
}
