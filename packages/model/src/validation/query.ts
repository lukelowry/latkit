import type { Schema, FieldDefinition } from '../schema.js';
import type { Problem } from '../types.js';
import { Check, index, kinds, numeric, own } from './check.js';
import type { Path } from './check.js';
import { domainValue } from './schema.js';

export function fieldsOf(
  schema: Schema,
  name: string,
): Readonly<Record<string, FieldDefinition>> | undefined {
  if (own(schema.types, name)) return schema.types[name].fields;
}

/** Validate request shape and described capabilities. Identity existence/staleness is source-owned. */
export function validateQuery(schema: Schema, value: unknown): readonly Problem[] {
  const c = new Check();
  const q = c.object(value, []);
  if (!c.enum(q.kind, kinds, ['kind'])) return c.issues;
  const validFrom = c.text(q.from, ['from']);
  const fields = validFrom ? fieldsOf(schema, q.from as string) : undefined;
  if (!fields) c.issue(['from'], 'Unknown source type.');
  if (own(q, 'rows')) selection(c, q.rows, ['rows'], typeof q.from === 'string' ? q.from : '');
  const selected = c.strings(q.select, ['select'], Object.keys(fields ?? {}), q.kind !== 'rows');
  const used = [...selected];
  if (q.kind === 'rows') {
    for (const key of ['count', 'ids']) c.optional(q, key, c.bool.bind(c), []);
    c.optional(q, 'offset', c.integer.bind(c), []);
    c.optional(q, 'limit', (v, p) => c.integer(v, p, 1), []);
    c.optional(q, 'at', c.finite.bind(c), []);
    if (own(q, 'where'))
      for (const [i, value] of c.array(q.where, ['where']).entries()) {
        const path = ['where', i];
        const filter = c.object(value, path);
        if (!c.text(filter.field, [...path, 'field']) || !fields || !own(fields, filter.field)) {
          c.issue([...path, 'field'], 'Unknown field.');
          continue;
        }
        used.push(filter.field);
        const field = fields[filter.field];
        c.enum(
          filter.operator,
          [
            'equal',
            'notEqual',
            'lessThan',
            'lessThanOrEqual',
            'greaterThan',
            'greaterThanOrEqual',
            'contains',
          ],
          [...path, 'operator'],
        );
        if (typeof field.type === 'object' && field.type.kind !== 'reference')
          c.issue(path, 'Filtering list/vector values is unsupported.');
        if (filter.operator === 'contains') {
          if (field.type !== 'text') c.issue(path, 'Contains requires text.');
          c.text(filter.value, [...path, 'value'], true);
        } else if (filter.operator === 'equal' || filter.operator === 'notEqual')
          domainValue(c, filter.value, field.type, true, [...path, 'value']);
        else {
          if (typeof field.type !== 'string' || !numeric.includes(field.type))
            c.issue(path, 'Ordered comparison requires numeric data.');
          c.finite(filter.value, [...path, 'value']);
        }
      }
    if (own(q, 'orderBy')) {
      const seen = new Set<string>();
      for (const [i, value] of c.array(q.orderBy, ['orderBy']).entries()) {
        const path = ['orderBy', i];
        const order = c.object(value, path);
        if (c.text(order.field, [...path, 'field'])) {
          if (!fields || !own(fields, order.field)) c.issue([...path, 'field'], 'Unknown field.');
          else if (typeof fields[order.field].type === 'object')
            c.issue(path, 'Ordering list, vector, or reference values is unsupported.');
          if (seen.has(order.field)) c.issue(path, 'Duplicate sort field.');
          seen.add(order.field);
          used.push(order.field);
        }
        c.enum(order.direction, ['ascending', 'descending'], [...path, 'direction']);
      }
    }
    const hasSamples = used.some((id) => fields && own(fields, id) && fields[id].sampled);
    if (hasSamples && !schema.axis)
      c.issue(
        ['at'],
        'This source declares outputs but has no readable observations.',
        'unsupported',
      );
    if (hasSamples !== own(q, 'at'))
      c.issue(['at'], 'A coordinate is required exactly when reading sampled fields.');
  } else {
    for (const id of selected)
      if (fields && own(fields, id)) {
        const field = fields[id];
        if (typeof field.type !== 'string' || !numeric.includes(field.type))
          c.issue(['select'], 'This query requires scalar numeric fields.');
        if ((q.kind === 'samples' || q.kind === 'envelope') && !field.sampled)
          c.issue(['select'], 'Samples require sampled fields.');
      }
    if (q.kind === 'envelope') {
      c.integer(q.buckets, ['buckets'], 1, 0x7fffffff);
      const range = c.object(q.window, ['window']);
      if (range.kind !== 'range') c.issue(['window'], 'Envelopes require a coordinate range.');
      if (Array.isArray(range.between) && range.between[0] === range.between[1] && q.buckets !== 1)
        c.issue(['buckets'], 'A zero-width interval requires one bucket.');
      if (!schema.axis)
        c.issue(['window'], 'This source has no readable observations.', 'unsupported');
    }
    if (q.kind === 'aggregate') {
      c.strings(q.measures, ['measures'], ['min', 'max'], true);
      const sampled = selected.filter(
        (id) => fields && own(fields, id) && fields[id].sampled,
      ).length;
      if (sampled && !schema.axis)
        c.issue(['window'], 'This source has no readable observations.', 'unsupported');
      if (sampled && sampled !== selected.length)
        c.issue(['select'], 'Input and sampled aggregates cannot be mixed.');
      if (Boolean(sampled) !== own(q, 'window'))
        c.issue(['window'], 'A window is required exactly for sampled aggregates.');
    }
    if (q.kind === 'samples' || q.kind === 'envelope' || own(q, 'window'))
      window(c, q.window, ['window']);
  }
  return c.issues;
}

function selection(c: Check, value: unknown, path: Path, from: string): void {
  const rows = c.object(value, path);
  if (rows.kind === 'ids') c.strings(rows.ids, [...path, 'ids']);
  else if (rows.kind === 'range') {
    if (own(rows, 'index')) index(c, rows.index, [...path, 'index'], from);
    const a = c.integer(rows.offset, [...path, 'offset'], 0, 0xffffffff);
    const b = c.integer(rows.count, [...path, 'count'], 0, 0x100000000);
    if (a && b && (rows.offset as number) + (rows.count as number) > 0x100000000)
      c.issue(path, 'Row range exceeds uint32 address space.');
  } else if (rows.kind === 'indices') {
    index(c, rows.index, [...path, 'index'], from);
    if (!(rows.values instanceof Uint32Array))
      c.issue([...path, 'values'], 'Expected Uint32Array.');
    else if (new Set(rows.values).size !== rows.values.length)
      c.issue([...path, 'values'], 'Duplicate row index.');
  } else c.issue([...path, 'kind'], 'Unknown row selection.');
}

function window(c: Check, value: unknown, path: Path): void {
  const w = c.object(value, path);
  if (own(w, 'context') && w.kind !== 'range')
    c.issue([...path, 'context'], 'Context requires a coordinate range.');
  if (w.kind === 'frames') {
    const a = c.integer(w.offset, [...path, 'offset']);
    const b = c.integer(w.count, [...path, 'count']);
    if (a && b && !Number.isSafeInteger((w.offset as number) + (w.count as number)))
      c.issue(path, 'Frame range exceeds safe integer precision.');
  } else if (w.kind === 'range') {
    if (own(w, 'context')) {
      const contextPath = [...path, 'context'];
      const context = c.object(w.context, contextPath);
      c.optional(context, 'before', c.integer.bind(c), contextPath);
      c.optional(context, 'after', c.integer.bind(c), contextPath);
    }
    const pair = c.array(w.between, [...path, 'between']);
    if (pair.length !== 2) c.issue([...path, 'between'], 'Expected an inclusive coordinate pair.');
    if (
      c.finite(pair[0], [...path, 'between', 0]) &&
      c.finite(pair[1], [...path, 'between', 1]) &&
      pair[0] > pair[1]
    )
      c.issue(path, 'Reversed coordinate range.');
  } else if (w.kind === 'at') c.finite(w.value, [...path, 'value']);
  else c.issue([...path, 'kind'], 'Unknown sample window.');
}
