import type { DataType } from '../data.js';
import type { Problem } from '../types.js';
import { bounds, Check, numeric, own, record } from './check.js';
import type { Path } from './check.js';

/** Structural/domain-description validation. Does not inspect implementation state or mutate input. */
export function validateSchema(value: unknown): readonly Problem[] {
  const c = new Check();
  const schema = c.object(value, []);
  const types = c.object(schema.types, ['types']);
  const names = new Set(Object.keys(types));
  for (const [id, value] of Object.entries(types)) {
    const path = ['types', id];
    c.text(id, path);
    const definition = c.object(value, path);
    for (const key of ['label', 'description'])
      c.optional(definition, key, (v, p) => c.text(v, p, true), path);
    const fields = c.object(definition.fields, [...path, 'fields']);
    for (const [name, fieldValue] of Object.entries(fields)) {
      const p = [...path, 'fields', name];
      c.text(name, p);
      const field = c.object(fieldValue, p);
      dataType(c, field.type, [...p, 'type'], names);
      for (const key of ['nullable', 'sampled']) c.optional(field, key, c.bool.bind(c), p);
      for (const key of ['label', 'description', 'unit'])
        c.optional(field, key, (v, at) => c.text(v, at, true), p);
      if (own(field, 'direction')) {
        c.enum(field.direction, ['in', 'out'], [...p, 'direction']);
        if (!record(field.type) || field.type.kind !== 'reference')
          c.issue([...p, 'direction'], 'Only a reference has a direction.');
      }
      if (field.sampled === true) {
        c.enum(field.type, numeric, [...p, 'type']);
        if (own(field, 'bounds'))
          c.issue([...p, 'bounds'], 'Sampled fields cannot declare bounds.');
      } else if (own(field, 'bounds')) {
        if (typeof field.type !== 'string' || !numeric.includes(field.type))
          c.issue([...p, 'bounds'], 'Bounds require a scalar numeric field.');
        bounds(c, field.bounds, [...p, 'bounds']);
      }
      if (own(field, 'geographic')) {
        c.bool(field.geographic, [...p, 'geographic']);
        const type = field.type,
          vector = record(type) && type.kind === 'list' ? type.items : type;
        const axis = typeof type === 'string' && numeric.includes(type),
          position =
            record(vector) && vector.kind === 'vector' && (vector.size === 2 || vector.size === 3);
        if (!axis && !position)
          c.issue([...p, 'geographic'], 'Only a position field is geographic.');
      }
    }
    if (own(definition, 'spatial'))
      c.issue([...path, 'spatial'], 'A position field says whether it is geographic.');
  }
  if (
    own(schema, 'axis') ||
    Object.values(types).some(
      (value) =>
        record(value) &&
        record(value.fields) &&
        Object.values(value.fields).some((field) => record(field) && field.sampled === true),
    )
  ) {
    const axis = c.object(schema.axis, ['axis']);
    c.text(axis.name, ['axis', 'name']);
    c.optional(axis, 'unit', c.text.bind(c), ['axis']);
  }
  return c.issues;
}

function dataType(c: Check, value: unknown, path: Path, names: Set<string>, depth = 0): boolean {
  const before = c.issues.length;
  if (depth > 32) {
    c.issue(path, 'Type nesting exceeds 32 levels.');
    return false;
  }
  if (typeof value === 'string') c.enum(value, [...numeric, 'text', 'boolean'], path);
  else {
    const type = c.object(value, path);
    if (type.kind === 'reference') {
      if (c.text(type.to, [...path, 'to']) && !names.has(type.to))
        c.issue([...path, 'to'], 'Unknown reference type.');
    } else if (type.kind === 'vector') {
      c.enum(type.items, numeric, [...path, 'items']);
      c.integer(type.size, [...path, 'size'], 1, 0x7fffffff);
    } else if (type.kind === 'list') dataType(c, type.items, [...path, 'items'], names, depth + 1);
    else c.issue([...path, 'kind'], 'Unknown data type.');
  }
  return before === c.issues.length;
}

export function domainValue(
  c: Check,
  value: unknown,
  type: DataType,
  nullable: boolean,
  path: Path,
): void {
  if (value === null) {
    if (!nullable) c.issue(path, 'Null requires nullable.');
    return;
  }
  if (typeof type === 'string') {
    if (type === 'text') c.text(value, path, true);
    else if (type === 'boolean') c.bool(value, path);
    else if (c.finite(value, path)) {
      if (type === 'uint32') c.integer(value, path, 0, 0xffffffff);
      if (type === 'int32') c.integer(value, path, -0x80000000, 0x7fffffff);
      if (type === 'float32' && !Number.isFinite(Math.fround(value)))
        c.issue(path, 'Value exceeds float32 range.');
    }
  } else if (type.kind === 'reference') c.text(value, path);
  else {
    const items = c.array(value, path);
    if (type.kind === 'vector' && items.length !== type.size)
      c.issue(path, 'Vector length differs from its size.');
    for (const [i, item] of items.entries()) domainValue(c, item, type.items, false, [...path, i]);
  }
}
