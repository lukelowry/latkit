import { blockBuffers } from '../buffers.js';
import type { Column, RowSelection } from '../data.js';
import { failure } from '../error.js';
import type { Data } from '../materialized.js';
import type { FieldDefinition, Schema } from '../schema.js';
import type { Keys } from './keys.js';
import type { Entry, Memory } from './memory.js';
import type { FieldBinding, FieldValues, FieldsRequest } from './types.js';

export interface PlannedGroup {
  readonly slot: number;
  readonly from: string;
  readonly rows?: RowSelection;
  readonly sampled: boolean;
  readonly fields: Map<string, string[]>;
}
export interface FieldPlan {
  readonly names: readonly string[];
  readonly external: readonly string[];
  readonly locals: readonly string[];
  readonly statics: readonly string[];
  readonly points: readonly PlannedGroup[];
  readonly samples: readonly PlannedGroup[];
  readonly width: number;
}
interface Cached {
  readonly plan: FieldPlan;
  readonly entry: Entry;
}
/** Compile immutable binding structure; plans never retain a Data snapshot. */
export class FieldPlans {
  private readonly plans = new Map<string, Cached>();
  private readonly hints = new WeakMap<object, WeakMap<Schema, Map<string, string>>>();
  constructor(
    private readonly memory: Memory,
    private readonly keys: Keys,
  ) {}
  acquire(
    fields: FieldsRequest['fields'],
    source: Data,
    from: string,
  ): Cached & { sources: Data[] } {
    let schemas = this.hints.get(fields);
    if (!schemas) this.hints.set(fields, (schemas = new WeakMap()));
    let names = schemas.get(source.schema);
    if (!names) schemas.set(source.schema, (names = new Map<string, string>()));
    const hint = names.get(from),
      hit = hint === undefined ? undefined : this.plans.get(hint);
    if (hit?.entry.live) {
      hit.entry.pin();
      return { ...hit, sources: this.sources(hit.plan, fields, source) };
    }
    const external: string[] = [],
      sources = [source],
      slots = new Map<Data, number>();
    const descriptors: unknown[] = [];
    const inputs: { alias: string; slot: number; binding: FieldBinding }[] = [];
    const locals: string[] = [];
    for (const [alias, input] of Object.entries(fields)) {
      if (typeof input !== 'string' && 'values' in input) {
        locals.push(alias);
        descriptors.push([alias, 'local', this.keys.id(input)]);
        continue;
      }
      const binding: FieldBinding =
        typeof input === 'string' ? { source, from, field: input } : input;
      if (binding.from !== from) throw failure('conflict', 'Fields must belong to one model type');
      let slot = 0;
      if (typeof input !== 'string') {
        const existing = slots.get(binding.source);
        if (existing !== undefined) slot = existing;
        else {
          slot = sources.length;
          slots.set(binding.source, slot);
          sources.push(binding.source);
          external.push(alias);
        }
      }
      descriptors.push([
        alias,
        slot,
        from,
        this.keys.selection(binding.rows),
        binding.field,
        this.keys.id(binding.source.schema),
      ]);
      inputs.push({ alias, slot, binding });
    }
    const key = JSON.stringify([from, this.keys.id(source.schema), descriptors]);
    let cached = this.plans.get(key);
    if (cached?.entry.live) cached.entry.pin();
    else {
      const statics = [...locals];
      const points: PlannedGroup[] = [],
        samples: PlannedGroup[] = [];
      const pointGroups = new Map<string, PlannedGroup>(),
        sampleGroups = new Map<string, PlannedGroup>();
      let width = 4;
      for (const alias of locals) width += bytesPerRow((fields[alias] as FieldValues).values);
      for (const { alias, slot, binding } of inputs) {
        const definition = binding.source.schema.types[from]?.fields[binding.field];
        if (!definition)
          throw failure('invalid-input', 'Unknown field: ' + from + '.' + binding.field);
        const sampled = definition.sampled === true;
        if (!sampled) statics.push(alias);
        width += definitionBytes(definition);
        const base = [slot, from, this.keys.selection(binding.rows)];
        const add = (map: Map<string, PlannedGroup>, groups: PlannedGroup[], groupKey: string) => {
          let group = map.get(groupKey);
          if (!group) {
            group = { slot, from, rows: binding.rows, sampled, fields: new Map() };
            map.set(groupKey, group);
            groups.push(group);
          }
          const aliases = group.fields.get(binding.field);
          if (aliases) aliases.push(alias);
          else group.fields.set(binding.field, [alias]);
        };
        // Point observations have independent clocks and dependencies, even within one source.
        add(pointGroups, points, JSON.stringify([...base, binding.field]));
        // Explicit sample windows retain their existing coordinate-alignment contract.
        if (sampled) add(sampleGroups, samples, JSON.stringify(base));
      }
      const plan: FieldPlan = {
        names: Object.keys(fields),
        external,
        locals,
        statics,
        points,
        samples,
        width,
      };
      const entry = this.memory.add(
        blockBuffers(points.map((group) => group.rows)),
        256 + key.length * 2 + plan.names.length * 192,
        () => {
          this.plans.delete(key);
        },
      );
      cached = { plan, entry };
      this.plans.set(key, cached);
    }
    names.set(from, key);
    return { ...cached, sources };
  }
  private sources(plan: FieldPlan, fields: FieldsRequest['fields'], source: Data): Data[] {
    return [source, ...plan.external.map((alias) => (fields[alias] as FieldBinding).source)];
  }
}
function definitionBytes(field: FieldDefinition): number {
  const type = field.type;
  if (typeof type === 'object' && type.kind === 'list') return 17;
  if (typeof type === 'object' && type.kind === 'vector') return type.size * 8 + 1;
  if (['float32', 'float64', 'int32', 'uint32', 'boolean'].includes(type as string)) return 9;
  return 17;
}
function bytesPerRow(column: Column): number {
  if (column.kind === 'text') return 5 + column.bytes.byteLength / Math.max(1, column.length);
  if (column.kind === 'list')
    return 8 + (bytesPerRow(column.values) * column.values.length) / Math.max(1, column.length);
  return (column.kind === 'vector' ? column.size : 1) * 8 + 1;
}
