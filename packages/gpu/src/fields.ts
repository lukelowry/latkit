import {
  blockBuffers,
  type Column,
  type FieldDefinition,
  type NumericArray,
  type Queryable,
  type RowAxis,
  type RowSelection,
  type RowsBlock,
  type Schema,
  type Update,
} from '@latkit/model';
import {
  assertIndex,
  rowAt,
  rowCount,
  sliceRows,
  type FieldBinding,
  type FieldsRequest,
  type FieldValues,
} from './binding.js';
import type { GpuPage } from './columns.js';
import { GpuError, interruptible } from './error.js';
import type { Entry, Memory } from './memory.js';
import type { Preparation } from './render.js';
import type { Uploader, UploadScope } from './uploads.js';

type Numeric = FieldValues['values'];
interface Resolved {
  columns: Record<string, Column>;
  presence: Record<string, Uint8Array>;
  entry: Entry;
}
interface Cached {
  index: FieldsRequest['index'];
  chunks: RowsBlock[];
  expected: Record<string, Numeric>;
  selection: RowSelection;
  entry: Entry;
  from: string;
  sampled: boolean;
  state: { stale: boolean };
}
interface Source {
  schema: Schema;
  entry: Entry;
  cache: Map<string, Cached>;
  closed: boolean;
}
interface Group {
  source: Queryable;
  state: Source;
  from: string;
  rows?: RowSelection;
  sampled: boolean;
  fields: Map<string, string[]>;
}
interface Tile {
  index: FieldsRequest['index'];
  rows: RowAxis;
  columns: Record<string, Column>;
  presence: Record<string, Uint8Array>;
}

/** Resolves native fields into one physical row order. Uploading remains the Uploader's job. */
export class Fields {
  private sources = new WeakMap<Queryable, Source>();
  private closed = new WeakSet<Queryable>();
  private ids = new WeakMap<object, number>();
  private serial = 0;
  private tiles = new Map<string, { entry: Entry; tile: Tile }>();
  constructor(
    private readonly memory: Memory,
    private readonly uploader: Uploader,
  ) {}

  async *prepare(
    request: FieldsRequest,
    frame: Pick<Preparation, 'query' | 'signal' | 'at'> & { observe(source: Queryable): void },
    scope: UploadScope,
  ): AsyncGenerator<GpuPage> {
    const count = rowCount(request.rows),
      names = Object.keys(request.fields);
    if (!names.length) throw new GpuError('invalid-input', 'Fields must be nonempty');
    if (!count) return;
    const states = new Map<Queryable, Source>();
    const groups: Group[] = [],
      values: [string, FieldValues][] = [];
    let width = 4;
    try {
      for (const [name, input] of Object.entries(request.fields)) {
        frame.signal.throwIfAborted();
        if (typeof input !== 'string' && 'values' in input) {
          assertIndex(request.index, input.index);
          values.push([name, input]);
          width += bytesPerRow(input.values);
          continue;
        }
        if (typeof input === 'string' && !request.source)
          throw new GpuError('invalid-input', 'String fields require a source');
        const binding: FieldBinding =
          typeof input === 'string'
            ? { source: request.source!, from: request.index.type, field: input }
            : input;
        if (binding.from !== request.index.type)
          throw new GpuError('conflict', 'Fields must belong to the draw index type');
        frame.observe(binding.source);
        let state = states.get(binding.source);
        if (!state) {
          state = await this.source(binding.source, frame.signal);
          states.set(binding.source, state);
          scope.use(state.entry);
          const current = state;
          scope.check(() => {
            if (current.closed) throw new GpuError('closed', 'Field source was closed');
          });
        }
        const definition =
          state.schema.components[binding.from] ??
          state.schema.connections[binding.from] ??
          state.schema.tables?.[binding.from];
        const field = definition?.fields[binding.field];
        if (!field)
          throw new GpuError(
            'invalid-input',
            'Unknown field: ' + binding.from + '.' + binding.field,
          );
        width += definitionBytes(field);
        const sampled = field.sampled === true;
        let group = groups.find(
          (g) =>
            g.source === binding.source &&
            g.from === binding.from &&
            g.sampled === sampled &&
            this.selectionKey(g.rows) === this.selectionKey(binding.rows),
        );
        if (!group) {
          group = {
            source: binding.source,
            state,
            from: binding.from,
            sampled,
            rows: binding.rows,
            fields: new Map(),
          };
          groups.push(group);
        }
        const aliases = group.fields.get(binding.field) ?? [];
        aliases.push(name);
        group.fields.set(binding.field, aliases);
      }
      // Both gathering and upload conversion are bounded; the stream never gathers the full model.
      const tileRows = Math.max(
        1,
        Math.floor(Math.min(this.uploader.pageBytes, this.memory.budget.stagingBytes / 2) / width),
      );
      for (let offset = 0; offset < count; offset += tileRows) {
        frame.signal.throwIfAborted();
        const rows = sliceRows(request.rows, offset, Math.min(tileRows, count - offset));
        const reads = new Map<Group, Cached>(),
          held: Entry[] = [];
        try {
          const cuts = new Set([0, rowCount(rows)]);
          for (const group of groups) {
            const resolved = await this.resolve(group, request.index, rows, frame);
            held.push(resolved.entry);
            reads.set(group, resolved);
            const state = resolved.state,
              sampled = group.sampled;
            scope.check(() => {
              if (state.stale && !sampled)
                throw new GpuError('conflict', 'Static fields changed during preparation');
            });
            for (const cut of boundaries(resolved.chunks, rows)) cuts.add(cut);
          }
          const sorted = [...cuts].sort((a, b) => a - b);
          for (let part = 1; part < sorted.length; part++) {
            const selected = sliceRows(rows, sorted[part - 1], sorted[part] - sorted[part - 1]);
            const columns = Object.create(null) as Record<string, Column>,
              presence = Object.create(null) as Record<string, Uint8Array>;
            const assembled: Entry[] = [];
            try {
              for (const [group, read] of reads) {
                const resolved = this.assemble(read, selected, group);
                assembled.push(resolved.entry);
                for (const [field, aliases] of group.fields)
                  for (const alias of aliases) {
                    columns[alias] = resolved.columns[field];
                    if (resolved.presence[field]) presence[alias] = resolved.presence[field];
                  }
              }
              for (const [name, input] of values) {
                const resolved = this.local(input, selected);
                assembled.push(resolved.entry);
                columns[name] = resolved.columns.value;
                if (resolved.presence.value) presence[name] = resolved.presence.value;
              }
              const key = JSON.stringify([
                request.index,
                this.axisKey(selected),
                names.map((name) => [name, this.id(columns[name]), this.id(presence[name])]),
              ]);
              let cached = this.tiles.get(key);
              if (!cached?.entry.live) {
                const tile = { index: request.index, rows: selected, columns, presence };
                const entry = this.memory.add(
                  backings(tile),
                  256 + names.length * 128 + key.length * 2,
                  () => this.tiles.delete(key),
                );
                cached = { tile, entry };
                this.tiles.set(key, cached);
                entry.unpin();
              }
              cached.entry.pin();
              try {
                for (const page of this.uploader.fields(
                  cached.tile,
                  { select: names, float64: request.float64 },
                  scope,
                )) {
                  frame.signal.throwIfAborted();
                  const rowOffset = offset + sorted[part - 1] + page.rowOffset;
                  yield rowOffset === page.rowOffset ? page : { ...page, rowOffset };
                }
              } finally {
                cached.entry.unpin();
              }
            } finally {
              for (const entry of assembled) entry.unpin();
            }
          }
        } finally {
          for (const entry of held) entry.unpin();
        }
      }
    } finally {
      for (const state of states.values()) state.entry.unpin();
    }
  }

  private id(value: object | undefined): number {
    if (!value) return 0;
    let id = this.ids.get(value);
    if (!id) {
      id = ++this.serial;
      this.ids.set(value, id);
    }
    return id;
  }
  private axisKey(rows: RowAxis): unknown {
    return rows.kind === 'range'
      ? ['range', rows.offset, rows.count]
      : ['indices', this.id(rows.values.buffer), rows.values.byteOffset, rows.values.length];
  }
  private selectionKey(rows?: RowSelection): string {
    return JSON.stringify(
      !rows
        ? null
        : rows.kind === 'ids'
          ? ['ids', this.id(rows.ids)]
          : [this.axisKey(rows), rows.index],
    );
  }
  private async source(source: Queryable, signal: AbortSignal): Promise<Source> {
    if (this.closed.has(source)) throw new GpuError('closed', 'Field source was closed');
    let state = this.sources.get(source);
    if (state?.entry.live) {
      state.entry.pin();
      return state;
    }
    const schema = await interruptible(source.describe({ signal }), signal);
    if (this.closed.has(source)) throw new GpuError('closed', 'Field source was closed');
    // A concurrent view may have completed the same description.
    state = this.sources.get(source);
    if (state?.entry.live) {
      state.entry.pin();
      return state;
    }
    let off = (): void => {};
    const entry = this.memory.add([], 256 + JSON.stringify(schema).length * 2, () => off());
    state = { schema, entry, cache: new Map(), closed: false };
    this.sources.set(source, state);
    const own = state;
    off = source.on('change', (change) => {
      if (change.kind === 'closed') {
        own.closed = true;
        this.closed.add(source);
      }
      for (const [key, cached] of own.cache)
        if (affects(change, cached)) {
          cached.state.stale = true;
          own.cache.delete(key);
          cached.entry.close();
        }
      if (change.kind === 'schema' || change.kind === 'replace' || change.kind === 'closed') {
        if (this.sources.get(source) === own) this.sources.delete(source);
        entry.close();
      }
    });
    return state;
  }

  private async resolve(
    group: Group,
    index: FieldsRequest['index'],
    rows: RowAxis,
    frame: Pick<Preparation, 'query' | 'signal' | 'at'>,
  ): Promise<Cached> {
    const selected = intersect(rows, group.rows, index),
      fields = [...group.fields.keys()].sort();
    const key = JSON.stringify([
      index,
      this.axisKey(rows),
      this.selectionKey(group.rows),
      fields,
      group.sampled ? (frame.at ?? null) : null,
    ]);
    const hit = group.state.cache.get(key);
    if (hit?.entry.live && !hit.state.stale) {
      hit.entry.pin();
      this.memory.queryHits++;
      return hit;
    }
    const chunks: RowsBlock[] = [],
      held: Entry[] = [];
    let changed = false;
    const off = group.source.on('change', (change) => {
      if (affects(change, group)) changed = true;
    });
    try {
      if (selected.kind === 'ids' || rowCount(selected)) {
        for await (const block of frame.query(group.source, {
          kind: 'rows',
          from: group.from,
          select: fields,
          rows: selected,
          ...(group.sampled ? { at: frame.at } : {}),
        })) {
          if (block.kind === 'schema') {
            if (block.schema.version !== group.state.schema.version)
              throw new GpuError('conflict', 'Field schema changed while preparing');
            continue;
          }
          assertIndex(index, block.index);
          for (const field of fields) {
            const column = block.columns[field];
            if (!column) throw new GpuError('invalid-input', 'Query omitted a requested field');
            this.uploader.validate(column, rowCount(block.rows));
          }
          const entry = this.memory.add(blockBuffers(block), 128, () => {});
          held.push(entry);
          chunks.push(block);
        }
      }
      if (group.state.closed) throw new GpuError('closed', 'Field source was closed');
      const definition =
        group.state.schema.components[group.from] ??
        group.state.schema.connections[group.from] ??
        group.state.schema.tables?.[group.from];
      const expected = Object.fromEntries(
        fields.map((field) => [field, emptyColumn(definition!.fields[field])]),
      );
      group.state.entry.pin();
      let entry: Entry;
      try {
        entry = this.memory.add(
          backings({ rows, chunks, selection: selected }),
          256 + key.length * 2 + fields.length * 128,
          () => {
            if (group.state.cache.get(key)?.entry === entry) group.state.cache.delete(key);
            group.state.entry.unpin();
          },
        );
      } catch (error) {
        group.state.entry.unpin();
        throw error;
      }
      const result: Cached = {
        index,
        chunks,
        expected,
        selection: selected,
        entry,
        from: group.from,
        sampled: group.sampled,
        state: { stale: false },
      };
      // The acquired data remains coherent even if an append arrives during the read. Don't cache it as latest.
      if (!changed) group.state.cache.set(key, result);
      else entry.close();
      return result;
    } finally {
      off();
      for (const entry of held) this.memory.remove(entry);
    }
  }

  private assemble(read: Cached, rows: RowAxis, group: Group): Resolved {
    const key = 'read:' + this.id(read) + ':' + JSON.stringify(this.axisKey(rows));
    const hit = this.tiles.get(key);
    if (hit?.entry.live) {
      hit.entry.pin();
      return { ...hit.tile, entry: hit.entry };
    }
    const result = assemble(
      rows,
      [...group.fields.keys()],
      read.chunks,
      !!group.rows,
      this.memory,
      read.expected,
      read.selection.kind === 'ids' ? undefined : read.selection,
    );
    const tile = { index: read.index, rows, ...result };
    const entry = this.memory.add(backings(tile), 256 + key.length * 2, () =>
      this.tiles.delete(key),
    );
    this.tiles.set(key, { entry, tile });
    return { ...result, entry };
  }

  private local(input: FieldValues, rows: RowAxis): Resolved {
    this.uploader.validate(input.values, rowCount(input.rows));
    const key = 'local:' + this.id(input) + ':' + JSON.stringify(this.axisKey(rows));
    const hit = this.tiles.get(key);
    if (hit?.entry.live) {
      hit.entry.pin();
      return { ...hit.tile, entry: hit.entry };
    }
    const result = assemble(
      rows,
      ['value'],
      [{ rows: input.rows, columns: { value: input.values } }],
      true,
      this.memory,
    );
    const tile = { index: input.index, rows, ...result };
    const entry = this.memory.add(backings(tile), 256, () => this.tiles.delete(key));
    this.tiles.set(key, { entry, tile });
    return { ...result, entry };
  }
}

function affects(change: Update, item: { from: string; sampled: boolean }): boolean {
  switch (change.kind) {
    case 'closed':
    case 'replace':
    case 'schema':
      return true;
    case 'data':
      return change.types.includes(item.from);
    case 'structure':
      return change.indexes.some((index) => index.type === item.from);
    case 'append':
    case 'evict':
      return item.sampled;
    default:
      return false;
  }
}
function definitionBytes(field: FieldDefinition): number {
  const type = field.type;
  if (typeof type === 'object' && type.kind === 'vector') return type.size * 8 + 1;
  if (['float32', 'float64', 'int32', 'uint32', 'boolean'].includes(type as string)) return 9;
  throw new GpuError('unsupported', 'GPU fields require numeric, vector, or boolean data');
}
function bytesPerRow(column: Numeric): number {
  return (column.kind === 'vector' ? column.size : 1) * 8 + 1;
}
function backings(value: unknown): ArrayBufferLike[] {
  const result = new Set<ArrayBufferLike>();
  const walk = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (ArrayBuffer.isView(item)) result.add(item.buffer);
    else for (const child of Object.values(item)) walk(child);
  };
  walk(value);
  return [...result];
}
function intersect(
  rows: RowAxis,
  selected: RowSelection | undefined,
  index: FieldsRequest['index'],
): RowSelection {
  if (!selected) return { ...rows, index };
  if (selected.kind === 'ids') return selected;
  if (selected.index) assertIndex(index, selected.index);
  if (rows.kind === 'range' && selected.kind === 'range') {
    const offset = Math.max(rows.offset, selected.offset);
    return {
      kind: 'range',
      index,
      offset,
      count: Math.max(
        0,
        Math.min(rows.offset + rows.count, selected.offset + selected.count) - offset,
      ),
    };
  }
  const lookup = selected.kind === 'indices' ? new Set(selected.values) : undefined;
  const values: number[] = [];
  for (let i = 0; i < rowCount(rows); i++) {
    const row = rowAt(rows, i);
    if (
      lookup
        ? lookup.has(row)
        : selected.kind === 'range' &&
          row >= selected.offset &&
          row < selected.offset + selected.count
    )
      values.push(row);
  }
  return { kind: 'indices', index, values: Uint32Array.from(values) };
}
function bit(values: Uint8Array | undefined, position: number): boolean {
  return !values || (values[position >>> 3] & (1 << (position & 7))) !== 0;
}
function mark(values: Uint8Array, position: number): void {
  values[position >>> 3] |= 1 << (position & 7);
}

function assemble(
  rows: RowAxis,
  fields: string[],
  chunks: readonly Pick<RowsBlock, 'rows' | 'columns'>[],
  partial: boolean,
  memory: Memory,
  expected: Record<string, Numeric> = {},
  required?: RowAxis,
): Pick<Resolved, 'columns' | 'presence'> {
  const count = rowCount(rows),
    columns: Record<string, Column> = Object.create(null) as Record<string, Column>,
    presence: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const chunk of chunks) {
    const offset = contiguous(chunk.rows, rows);
    if (offset === undefined) continue;
    for (const name of fields) {
      const column = chunk.columns[name];
      if (!column) throw new GpuError('invalid-input', 'Query omitted a requested field');
      columns[name] =
        offset === 0 && column.length === count
          ? column
          : { ...column, offset: column.offset + offset, length: count };
    }
    return { columns, presence };
  }
  const requiredRows = required?.kind === 'indices' ? new Set(required.values) : undefined;
  const positions = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const row = rowAt(rows, i),
      list = positions.get(row) ?? [];
    list.push(i);
    positions.set(row, list);
  }
  for (const name of fields) {
    const sample = chunks.find((chunk) => chunk.columns[name])?.columns[name] ?? expected[name];
    if (
      sample &&
      sample.kind !== 'numeric' &&
      sample.kind !== 'vector' &&
      sample.kind !== 'boolean'
    )
      throw new GpuError('unsupported', 'GPU fields require numeric, vector, or boolean data');
    const numeric = sample as Numeric | undefined,
      components = numeric?.kind === 'vector' ? numeric.size : 1;
    const scalar = numeric?.kind === 'vector' ? numeric.values : numeric;
    const size = count * components,
      maskBytes = Math.ceil(count / 8);
    const Constructor = (scalar?.values.constructor ?? Float32Array) as {
      new (length: number): NumericArray;
      readonly BYTES_PER_ELEMENT: number;
    };
    const bytes =
      (numeric?.kind === 'boolean' ? maskBytes : size * Constructor.BYTES_PER_ELEMENT) +
      maskBytes * 2;
    const result = memory.stage(bytes, () => {
      const values =
        numeric?.kind === 'boolean' ? new Uint8Array(maskBytes) : new Constructor(size);
      const valid = new Uint8Array(maskBytes),
        present = new Uint8Array(maskBytes);
      let hasNull = false;
      for (const chunk of chunks) {
        const column = chunk.columns[name] as Numeric;
        if (!column) throw new GpuError('invalid-input', 'Query omitted a requested field');
        if (
          numeric &&
          (column.kind !== numeric.kind || (column.kind === 'vector' && column.size !== components))
        )
          throw new GpuError('conflict', 'Field type changed across query blocks');
        for (let i = 0; i < rowCount(chunk.rows); i++)
          for (const target of positions.get(rowAt(chunk.rows, i)) ?? []) {
            if (bit(present, target))
              throw new GpuError('invalid-input', 'Query returned a physical row twice');
            mark(present, target);
            const at = column.offset + i;
            if (!bit(column.validity, at)) {
              hasNull = true;
              continue;
            }
            mark(valid, target);
            if (column.kind === 'boolean') {
              if (bit(column.values, at)) mark(values as Uint8Array, target);
            } else if (column.kind === 'vector')
              for (let lane = 0; lane < components; lane++)
                values[target * components + lane] =
                  column.values.values[column.values.offset + at * components + lane];
            else values[target] = column.values[at];
          }
      }
      let complete = true;
      for (let i = 0; i < count; i++)
        if (!bit(present, i)) {
          complete = false;
          const row = rowAt(rows, i);
          if (
            !partial ||
            requiredRows?.has(row) ||
            (required?.kind === 'range' &&
              row >= required.offset &&
              row < required.offset + required.count)
          )
            throw new GpuError('invalid-input', 'Query did not cover the requested draw rows');
        }
      const base = { offset: 0, length: count, validity: hasNull ? valid : undefined };
      const column: Numeric =
        numeric?.kind === 'boolean'
          ? { ...base, kind: 'boolean', values: values as Uint8Array }
          : numeric?.kind === 'vector'
            ? {
                ...base,
                kind: 'vector',
                size: components,
                values: {
                  kind: 'numeric',
                  offset: 0,
                  length: size,
                  values: values as NumericArray,
                },
              }
            : { ...base, kind: 'numeric', values: values as NumericArray };
      return { column, present: complete ? undefined : present };
    });
    columns[name] = result.column;
    if (result.present) presence[name] = result.present;
  }
  return { columns, presence };
}

function contiguous(source: RowAxis, target: RowAxis): number | undefined {
  if (source.kind === 'range' && target.kind === 'range') {
    const offset = target.offset - source.offset;
    if (offset >= 0 && offset + target.count <= source.count) return offset;
  }
  if (
    source.kind === 'indices' &&
    target.kind === 'indices' &&
    source.values.buffer === target.values.buffer
  ) {
    const offset = (target.values.byteOffset - source.values.byteOffset) / 4;
    if (offset >= 0 && offset + target.values.length <= source.values.length) return offset;
  }
  if (!rowCount(target)) return 0;
  const first = rowAt(target, 0);
  const offset = source.kind === 'range' ? first - source.offset : source.values.indexOf(first);
  if (offset < 0 || offset + rowCount(target) > rowCount(source)) return;
  for (let i = 0; i < rowCount(target); i++)
    if (rowAt(source, offset + i) !== rowAt(target, i)) return;
  return offset;
}
function boundaries(chunks: readonly RowsBlock[], rows: RowAxis): number[] {
  const result: number[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const count = rowCount(chunk.rows);
    if (
      !count ||
      offset + count > rowCount(rows) ||
      contiguous(chunk.rows, sliceRows(rows, offset, count)) !== 0
    )
      return [];
    offset += count;
    result.push(offset);
  }
  return offset === rowCount(rows) ? result : [];
}

function emptyColumn(field: FieldDefinition): Numeric {
  const type = field.type;
  if (type === 'boolean')
    return { kind: 'boolean', offset: 0, length: 0, values: new Uint8Array() };
  const scalar = typeof type === 'object' && type.kind === 'vector' ? type.items : type;
  const values =
    scalar === 'float64'
      ? new Float64Array()
      : scalar === 'int32'
        ? new Int32Array()
        : scalar === 'uint32'
          ? new Uint32Array()
          : new Float32Array();
  const column = { kind: 'numeric' as const, offset: 0, length: 0, values };
  return typeof type === 'object' && type.kind === 'vector'
    ? { kind: 'vector', offset: 0, length: 0, size: type.size, values: column }
    : column;
}
