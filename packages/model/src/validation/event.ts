import type { Schema } from '../schema.js';
import type { MonitorOptions } from '../model.js';
import type { Problem } from '../types.js';
import { blockByteLength } from '../buffers.js';
import { Check, record } from './check.js';
import { validateBlock } from './block.js';
import { validateQuery } from './query.js';

/** Validate delivered values at a trust boundary, before exposing them to application code. */
export function validateDataEvent(
  schema: Schema,
  value: unknown,
  options: MonitorOptions = {},
): readonly Problem[] {
  const c = new Check();
  const event = c.object(value, []);
  c.text(event.version, ['version']);
  c.enum(event.kind, ['begin', 'data', 'end'], ['kind']);
  if (event.kind === 'begin') c.bool(event.initial, ['initial']);
  if (event.kind !== 'data') return c.issues;
  if (
    blockByteLength(value) >
    Math.min(schema.limits.maxBlockBytes, options.maxBlockBytes ?? Infinity)
  ) {
    c.issue([], 'Data event exceeds its payload bound.', 'resource-limit');
    return c.issues;
  }
  const batch = c.object(event.block, ['block']);
  c.enum(batch.kind, ['rows', 'samples'], ['block', 'kind']);
  if ('replace' in batch) c.issue(['block', 'replace'], 'Replacement operations are unsupported.');
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
  const q = query as import('../query.js').Query;
  const issues = validateQuery(schema, q);
  if (issues.length) return [...c.issues, ...issues];
  return [
    ...c.issues,
    ...validateBlock(
      schema,
      q,
      { ...batch, version: event.version, position: 0, rowOffset: 0 },
      options,
    ),
  ];
}
