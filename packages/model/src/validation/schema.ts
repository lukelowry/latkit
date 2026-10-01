import type { DataType } from '../data.js';
import type { Problem } from '../types.js';
import { bounds, Check, kinds, numeric, own, record } from './check.js';
import type { Path } from './check.js';

/** Structural/domain-description validation. Does not inspect implementation state or mutate input. */
export function validateSchema(value: unknown): readonly Problem[] {
  const c = new Check();
  const schema = c.object(value, []);
  c.strings(schema.queries, ['queries'], kinds);
  c.integer(c.object(schema.limits, ['limits']).maxBlockBytes, ['limits', 'maxBlockBytes'], 1);
  const names = new Set<string>();
  const entries: [string, Record<string, unknown>, Path][] = [];
  for (const category of ['components', 'connections', 'tables']) {
    if (category === 'tables' && !own(schema, category)) continue;
    for (const [id, value] of Object.entries(c.object(schema[category], [category]))) {
      const path = [category, id];
      c.text(id, path);
      if (names.has(id)) c.issue(path, 'Type name must be unique across the schema.');
      names.add(id);
      entries.push([category, c.object(value, path), path]);
    }
  }

  for (const [category, definition, path] of entries) {
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
      if (field.sampled === true) {
        c.enum(field.type, numeric, [...p, 'type']);
        if (own(field, 'bounds'))
          c.issue([...p, 'bounds'], 'Sampled fields cannot declare bounds.');
      } else if (own(field, 'bounds')) {
        if (typeof field.type !== 'string' || !numeric.includes(field.type))
          c.issue([...p, 'bounds'], 'Bounds require a scalar numeric field.');
        bounds(c, field.bounds, [...p, 'bounds']);
      }
    }
    if (category === 'components' && own(definition, 'ports'))
      for (const [id, portValue] of Object.entries(
        c.object(definition.ports, [...path, 'ports']),
      )) {
        const p = [...path, 'ports', id];
        c.text(id, p);
        const port = c.object(portValue, p);
        c.enum(port.direction, ['in', 'out', 'both'], [...p, 'direction']);
        for (const key of ['label', 'type']) c.optional(port, key, c.text.bind(c), p);
      }
    if (category === 'connections')
      for (const [id, roleValue] of Object.entries(
        c.object(definition.roles, [...path, 'roles']),
      )) {
        const p = [...path, 'roles', id];
        c.text(id, p);
        const role = c.object(roleValue, p);
        const valid = c.integer(role.min, [...p, 'min']);
        if (own(role, 'max')) c.integer(role.max, [...p, 'max'], valid ? (role.min as number) : 0);
        c.optional(role, 'direction', (v, at) => c.enum(v, ['in', 'out', 'both'], at), p);
      }
    if (own(definition, 'spatial')) {
      const p = [...path, 'spatial'];
      const spatial = c.object(definition.spatial, p);
      c.text(spatial.system, [...p, 'system']);
      if (c.text(spatial.field, [...p, 'field'])) {
        const field = fields[spatial.field];
        const type = record(field) ? field.type : undefined;
        const vector = record(type) && type.kind === 'list' ? type.items : type;
        if (!record(vector) || vector.kind !== 'vector' || (vector.size !== 2 && vector.size !== 3))
          c.issue(
            [...p, 'field'],
            'Spatial field must be a 2D/3D vector or a list of those vectors.',
          );
      }
    }
  }
  if (
    (Array.isArray(schema.queries) &&
      (schema.queries.includes('samples') || schema.queries.includes('envelope'))) ||
    own(schema, 'axis')
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
