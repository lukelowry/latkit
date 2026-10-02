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
  const patch = c.object(event.patch, ['patch']);
  c.enum(patch.kind, ['rows', 'samples'], ['patch', 'kind']);
  if (patch.replace !== undefined) c.bool(patch.replace, ['patch', 'replace']);
  if (!record(patch.columns) || !record(patch.index))
    return [...c.issues, { code: 'invalid-input', message: 'Missing columns or row identity.' }];
  const query =
    patch.kind === 'samples'
      ? {
          kind: 'samples',
          from: patch.index.type,
          select: Object.keys(patch.columns),
          window: {
            kind: 'frames',
            offset: patch.firstFrame,
            count: patch.coordinates instanceof Float64Array ? patch.coordinates.length : 0,
          },
        }
      : {
          kind: 'rows',
          from: patch.index.type,
          select: Object.keys(patch.columns),
          ...(patch.ids ? { ids: true } : {}),
        };
  const q = query as import('../query.js').Query;
  const issues = validateQuery(schema, q);
  if (issues.length) return [...c.issues, ...issues];
  return [
    ...c.issues,
    ...validateBlock(
      schema,
      q,
      { ...patch, version: event.version, position: 0, rowOffset: 0 },
      options,
    ),
  ];
}
