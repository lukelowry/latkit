import { assertIndex, bitAt, rowAt, rowCount, setBit, sliceRows } from '../access.js';
import { blockBuffers } from '../buffers.js';
import { gather, position, type Cell } from '../columns.js';
import type {
  Column,
  Index,
  NumericArray,
  RowAxis,
  RowSelection,
  SampleColumn,
  TextColumn,
} from '../data.js';
import { failure } from '../error.js';
import type { Data } from '../materialized.js';
import type { Query, RowsBlock, SamplesBlock, SampleWindow } from '../query.js';
import { emptyColumn, intersect, resolveRows, type ReadResult } from '../read.js';
import type { Schema } from '../schema.js';
import type { Domain } from '../types.js';
import type { Keys } from './keys.js';
import type { Entry, Memory } from '../memory.js';
import { FieldPlans } from './plans.js';
import type {
  ExtentRequest,
  FieldBinding,
  FieldInput,
  FieldsBlock,
  FieldsRequest,
  FieldValues,
} from './types.js';

/** What a field read needs from its scope: cached reads, a coordinate, and result holding. */
export interface FieldScope {
  readonly signal: AbortSignal;
  readonly at?: number;
  read<Q extends Query>(data: Data, query: Q): AsyncIterable<ReadResult<Q>>;
  use(entry: Entry): void;
}

type Numeric = Exclude<Column, { kind: 'list' | 'text' | 'reference' }>;
interface IndexedFields {
  readonly source: Data;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly fields: FieldsRequest['fields'];
}
interface IndexedExtent {
  readonly source?: Data;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly field: FieldInput;
  readonly window?: SampleWindow;
}
interface Resolved {
  columns: Record<string, Column>;
  presence: Record<string, Uint8Array>;
  entry: Entry;
}
interface Cached {
  index: Index;
  chunks: RowsBlock[];
  expected: Record<string, Column>;
  selection: RowSelection;
  entry: Entry;
  from: string;
  sampled: boolean;
  table: string;
  dependencies: Readonly<Record<string, string>>;
}
interface Extent {
  entry: Entry;
  from: string;
  sampled: boolean;
  value: Domain | null;
}
interface SchemaState {
  schema: Schema;
  entry: Entry;
  cache: Map<string, Cached>;
  byField: Map<string, Set<Cached>>;
  extents: Map<string, Extent>;
}
interface Group {
  source: Data;
  state: SchemaState;
  from: string;
  rows?: RowSelection;
  sampled: boolean;
  fields: Map<string, string[]>;
}
interface ColumnRead {
  group: Group;
  index: Index;
  rows: RowAxis;
  selected: RowSelection;
  fields: string[];
  table: string;
  dependencies: Record<string, string>;
  key: string;
}
interface Tile {
  index: Index;
  rows: RowAxis;
  columns: Record<string, Column>;
  presence: Record<string, Uint8Array>;
}
type Block = Omit<FieldsBlock, 'kind'>;

/** Resolves fields of one or more sources into one physical row order, in bounded tiles. */
export class Fields {
  private schemas = new WeakMap<Schema, SchemaState>();
  private tiles = new Map<string, { entry: Entry; tile: Tile }>();
  private readonly plans: FieldPlans;
  constructor(
    private readonly memory: Memory,
    private readonly keys: Keys,
    private readonly tileBytes: number,
  ) {
    this.plans = new FieldPlans(memory, keys);
  }

  async *read(request: FieldsRequest, scope: FieldScope): AsyncGenerator<FieldsBlock> {
    if (!request.from) throw failure('invalid-input', 'Fields require a model type');
    for await (const block of this.blocks(request, scope)) yield { kind: 'fields', ...block };
  }

  private async *blocks(request: FieldsRequest, scope: FieldScope): AsyncGenerator<Block> {
    if (request.window) {
      yield* this.sampled(request, scope);
      return;
    }
    if (request.rows && request.rows.kind !== 'ids' && request.rows.index && !request.ids) {
      if (request.rows.index.type !== request.from)
        throw failure('conflict', 'Selection belongs to another type');
      yield* this.indexed({ ...request, index: request.rows.index, rows: request.rows }, scope);
      return;
    }
    const compiled = this.plans.acquire(request.fields, request.source, request.from);
    try {
      scope.signal.throwIfAborted();
      const select = compiled.plan.points
        .filter((group) => compiled.sources[group.slot] === request.source && !group.rows)
        .flatMap((group) => [...group.fields.keys()]);
      const sampled = select.some(
        (name) => request.source.schema.types[request.from].fields[name].sampled,
      );
      const mapping = resolveRows(request.source, {
        from: request.from,
        select,
        rows: request.rows,
        ...(sampled ? { at: scope.at } : {}),
      });
      if (!mapping) return;
      if (!request.ids) {
        yield* this.indexed({ ...request, ...mapping }, scope);
        return;
      }
      // IDs are gathered separately; field values retain their independent cache identities.
      for await (const block of scope.read(request.source, {
        kind: 'rows',
        from: request.from,
        rows: { ...mapping.rows, index: mapping.index },
        select: [],
        ids: true,
      })) {
        const held = this.memory.add(blockBuffers(block), 128, () => {});
        try {
          for await (const tile of this.indexed(
            { ...request, index: block.index, rows: block.rows },
            scope,
          )) {
            const ids = block.ids && {
              ...block.ids,
              offset: block.ids.offset + tile.rowOffset,
              length: rowCount(tile.rows),
            };
            scope.signal.throwIfAborted();
            yield { ...tile, rowOffset: block.rowOffset + tile.rowOffset, ...(ids ? { ids } : {}) };
          }
        } finally {
          this.memory.remove(held);
        }
      }
    } finally {
      compiled.entry.unpin();
    }
  }

  private async *sampled(request: FieldsRequest, scope: FieldScope): AsyncGenerator<Block> {
    const compiled = this.plans.acquire(request.fields, request.source, request.from);
    try {
      const groups = compiled.plan.samples.map((group) => ({
        ...group,
        source: compiled.sources[group.slot],
      }));
      const statics = Object.fromEntries(
        compiled.plan.statics.map((alias) => [alias, request.fields[alias]]),
      );
      if (!groups.length) throw failure('invalid-input', 'A sample window requires sampled fields');
      const anchor = groups.find((g) => !g.rows);
      if (!anchor)
        throw failure('invalid-input', 'A sampled read requires one complete field binding');
      for await (const block of scope.read(anchor.source, {
        kind: 'samples',
        from: request.from,
        rows: request.rows,
        select: [...anchor.fields.keys()],
        window: request.window!,
      })) {
        const held = this.memory.add(blockBuffers(block), 128, () => {}),
          joined: Entry[] = [];
        try {
          const sampledColumns: Record<string, SampleColumn> = {};
          const sampledPresence: Record<string, Uint8Array> = {};
          for (const [field, aliases] of anchor.fields)
            for (const alias of aliases) sampledColumns[alias] = block.columns[field];
          for (const group of groups) {
            if (group === anchor) continue;
            const chunks: SamplesBlock[] = [],
              entries: Entry[] = [];
            const selected = intersectSelection(block.rows, group.rows, block.index);
            try {
              for await (const part of scope.read(group.source, {
                kind: 'samples',
                from: request.from,
                rows: selected,
                select: [...group.fields.keys()],
                window: {
                  kind: 'frames',
                  offset: block.firstFrame,
                  count: block.coordinates.length,
                },
              })) {
                assertIndex(block.index, part.index);
                chunks.push(part);
                entries.push(this.memory.add(blockBuffers(part), 128, () => {}));
              }
              const merged = joinSamples(
                block,
                chunks,
                [...group.fields.keys()],
                !!group.rows,
                this.memory,
                selected.kind === 'ids' ? undefined : selected,
              );
              joined.push(this.memory.add(blockBuffers(merged), 128, () => {}));
              for (const [field, aliases] of group.fields)
                for (const alias of aliases) {
                  sampledColumns[alias] = merged.columns[field];
                  if (merged.presence[field]) sampledPresence[alias] = merged.presence[field];
                }
            } finally {
              for (const entry of entries) this.memory.remove(entry);
            }
          }
          // Static columns retain their native row addressing and broadcast over the sample axis.
          for await (const tile of this.indexed(
            { source: request.source, index: block.index, rows: block.rows, fields: statics },
            scope,
          )) {
            const columns: Record<string, Column> = { ...tile.columns };
            for (const [name, column] of Object.entries(sampledColumns))
              columns[name] = {
                ...column,
                offset: column.offset + tile.rowOffset * column.rowStride,
                length:
                  (block.coordinates.length - 1) * column.frameStride +
                  (rowCount(tile.rows) - 1) * column.rowStride +
                  1,
              };
            const presence = { ...tile.presence };
            for (const [name, mask] of Object.entries(sampledPresence))
              presence[name] = this.memory.stage(Math.ceil(rowCount(tile.rows) / 8), () =>
                sliceBits(mask, tile.rowOffset, rowCount(tile.rows)),
              );
            let ids: TextColumn | undefined;
            let identityEntry: Entry | undefined;
            if (request.ids) {
              const chunks: RowsBlock[] = [],
                heldIds: Entry[] = [];
              try {
                for await (const part of scope.read(request.source, {
                  kind: 'rows',
                  from: request.from,
                  rows: { ...tile.rows, index: tile.index },
                  select: [],
                  ids: true,
                })) {
                  assertIndex(tile.index, part.index);
                  if (!part.ids) throw failure('invalid-input', 'Identity query omitted ids');
                  heldIds.push(this.memory.add(blockBuffers(part), 128, () => {}));
                  chunks.push({ ...part, columns: { ids: part.ids } });
                }
                ids = assemble(tile.rows, ['ids'], chunks, false, this.memory).columns
                  .ids as TextColumn;
                identityEntry = this.memory.add(blockBuffers(ids), 128, () => {});
              } finally {
                for (const entry of heldIds) this.memory.remove(entry);
              }
            }
            try {
              const data: Block = {
                ...tile,
                rowOffset: block.rowOffset + tile.rowOffset,
                columns,
                presence,
                ...(ids ? { ids } : {}),
                samples: { firstFrame: block.firstFrame, coordinates: block.coordinates },
              };
              const entry = this.memory.add(blockBuffers(data), 128, () => {});
              try {
                scope.signal.throwIfAborted();
                yield data;
              } finally {
                this.memory.remove(entry);
              }
            } finally {
              if (identityEntry) this.memory.remove(identityEntry);
            }
          }
        } finally {
          for (const entry of joined) this.memory.remove(entry);
          this.memory.remove(held);
        }
      }
    } finally {
      compiled.entry.unpin();
    }
  }

  private async *indexed(request: IndexedFields, scope: FieldScope): AsyncGenerator<Block> {
    const count = rowCount(request.rows);
    if (!count) return;
    const compiled = this.plans.acquire(request.fields, request.source, request.index.type);
    const { plan, sources } = compiled;
    const { names, width } = plan;
    const states = new Map<Data, SchemaState>();
    const groups: Group[] = [];
    const values = plan.locals.map((name) => [name, request.fields[name] as FieldValues] as const);
    try {
      for (const [, input] of values) assertIndex(request.index, input.index);
      for (const planned of plan.points) {
        scope.signal.throwIfAborted();
        const source = sources[planned.slot];
        let state = states.get(source);
        if (!state) {
          state = this.schemaState(source, scope.signal);
          states.set(source, state);
          scope.use(state.entry);
        }
        groups.push({ ...planned, source, state });
      }
      // Both gathering and upload conversion are bounded; the stream never gathers the full model.
      const tileRows = Math.max(
        1,
        Math.floor(Math.min(this.tileBytes, this.memory.budget.stagingBytes / 2) / width),
      );
      for (let offset = 0; offset < count; offset += tileRows) {
        scope.signal.throwIfAborted();
        const rows = sliceRows(request.rows, offset, Math.min(tileRows, count - offset));
        const reads = await this.resolveAll(groups, request.index, rows, scope);
        try {
          const cuts = new Set([0, rowCount(rows)]);
          for (const resolved of reads.values())
            for (const cut of boundaries(resolved.chunks, rows)) cuts.add(cut);
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
                this.keys.axis(selected),
                names.map((name) => [
                  name,
                  this.keys.id(columns[name]),
                  this.keys.id(presence[name]),
                ]),
              ]);
              let cached = this.tiles.get(key);
              if (!cached?.entry.live) {
                const tile = { index: request.index, rows: selected, columns, presence };
                const entry = this.memory.add(
                  blockBuffers(tile),
                  256 + names.length * 128 + key.length * 2,
                  () => this.tiles.delete(key),
                );
                cached = { tile, entry };
                this.tiles.set(key, cached);
                entry.unpin();
              }
              cached.entry.pin();
              try {
                scope.signal.throwIfAborted();
                yield {
                  index: request.index,
                  rows: selected,
                  rowOffset: offset + sorted[part - 1],
                  columns: cached.tile.columns,
                  presence: cached.tile.presence,
                };
              } finally {
                cached.entry.unpin();
              }
            } finally {
              for (const entry of assembled) entry.unpin();
            }
          }
        } finally {
          for (const read of reads.values()) read.entry.unpin();
        }
      }
    } finally {
      for (const state of states.values()) state.entry.unpin();
      compiled.entry.unpin();
    }
  }

  /** The finite extent of one field over the requested rows, cached by the values it reads. */
  async extent(request: ExtentRequest, scope: FieldScope): Promise<Domain | null> {
    const { source, from, rows, field, window } = request;
    if (rows && rows.kind !== 'ids' && rows.index)
      return this.extentOf({ source, index: rows.index, rows, field, window }, scope);
    if (!window) {
      const name =
        typeof field === 'string'
          ? field
          : 'field' in field && field.source === source && field.from === from && !field.rows
            ? field.field
            : undefined;
      const sampled = name && source.schema.types[from]?.fields[name]?.sampled;
      scope.signal.throwIfAborted();
      const mapping = resolveRows(source, {
        from,
        select: name ? [name] : [],
        rows,
        ...(sampled ? { at: scope.at } : {}),
      });
      return mapping ? this.extentOf({ source, ...mapping, field }, scope) : null;
    }
    const binding =
      typeof field === 'string'
        ? { source, from, field }
        : 'field' in field && field.from === from && !field.rows
          ? field
          : undefined;
    // A whole field over a window is one reduction; its sample blocks never enter the cache.
    if (binding && (binding.source === source || rows?.kind !== 'ids'))
      return aggregateExtent(scope, binding, rows, window);
    let lo = Infinity,
      hi = -Infinity;
    for await (const tile of this.read(
      { source, from, rows, fields: { value: field }, window },
      scope,
    )) {
      const extent = tileExtent(tile, 'value');
      if (extent) {
        lo = Math.min(lo, extent[0]);
        hi = Math.max(hi, extent[1]);
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }

  private async extentOf(request: IndexedExtent, scope: FieldScope): Promise<Domain | null> {
    scope.signal.throwIfAborted();
    const input = request.field;
    let lo = Infinity,
      hi = -Infinity;
    const include = (value: number) => {
      if (Number.isFinite(value)) {
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    };
    const scan = (column: Column, count: number, presence?: Uint8Array) => {
      if (column.kind !== 'numeric')
        throw failure('invalid-input', 'Extents require scalar numeric fields');
      for (let i = 0; i < count; i++) {
        const at = column.offset + i;
        if (bitAt(presence, i) && bitAt(column.validity, at)) include(column.values[at]);
      }
    };
    if (typeof input === 'object' && 'values' in input) {
      if (request.window) throw failure('invalid-input', 'Local values have no sample window');
      assertIndex(request.index, input.index);
      const local = this.local(input, request.rows);
      try {
        scan(local.columns.value, rowCount(request.rows), local.presence.value);
      } finally {
        local.entry.unpin();
      }
      return lo <= hi ? [lo, hi] : null;
    }
    if (typeof input === 'string' && !request.source)
      throw failure('invalid-input', 'String fields require a source');
    const binding: FieldBinding =
      typeof input === 'string'
        ? { source: request.source!, from: request.index.type, field: input }
        : input;
    if (binding.from !== request.index.type)
      throw failure('conflict', 'Extent field must belong to the selected index');
    const state = this.schemaState(binding.source, scope.signal);
    try {
      scope.use(state.entry);
      const definition = state.schema.types[binding.from];
      const field = definition?.fields[binding.field];
      if (!field || !['float32', 'float64', 'int32', 'uint32'].includes(field.type as string))
        throw failure('invalid-input', 'Extents require scalar numeric fields');
      const sampled = field.sampled === true;
      if (request.window && !sampled)
        throw failure('invalid-input', 'Static fields have no sample window');
      const window =
        request.window ??
        (sampled && scope.at !== undefined ? { kind: 'at' as const, value: scope.at } : undefined);
      if (sampled && !window)
        throw failure('invalid-input', 'Sampled extents require a coordinate or window');
      const rows = intersectSelection(request.rows, binding.rows, request.index);
      const table = this.keys.table(binding.source, binding.from);
      const dependency = this.keys.field(binding.source, binding.from, binding.field, window);
      const key = JSON.stringify([
        table,
        request.index,
        this.keys.axis(request.rows),
        this.keys.selection(binding.rows),
        binding.field,
        dependency,
        window?.kind === 'at' ? 'at' : window,
      ]);
      const cached = state.extents.get(key);
      if (cached?.entry.live) {
        scope.use(cached.entry);
        this.memory.queryHits++;
        return cached.value;
      }
      const native =
        !request.window &&
        [...(state.byField.get(readKey(table, binding.field, dependency)) ?? [])].find(
          (cached) =>
            cached.entry.live &&
            cached.from === binding.from &&
            cached.sampled === sampled &&
            cached.table === table &&
            cached.dependencies[binding.field] === dependency &&
            binding.field in cached.expected &&
            cached.selection.kind !== 'ids' &&
            rows.kind !== 'ids' &&
            contiguous(cached.selection, rows) !== undefined &&
            cached.index.source === request.index.source &&
            cached.index.version === request.index.version,
        );
      const group: Group = {
        source: binding.source,
        state,
        from: binding.from,
        sampled,
        rows: binding.rows,
        fields: new Map([[binding.field, ['value']]]),
      };
      if (native) {
        const assembled = this.assemble(native, request.rows, group);
        try {
          scan(
            assembled.columns[binding.field],
            rowCount(request.rows),
            assembled.presence[binding.field],
          );
        } finally {
          assembled.entry.unpin();
        }
      } else if (rows.kind !== 'ids') {
        const extent = await aggregateExtent(scope, binding, rows, window);
        if (extent) {
          include(extent[0]);
          include(extent[1]);
        }
      } else if (window && window.kind !== 'at') {
        // Window reads use the same native scalar/stride rules as field uploads.
        const selected = request.rows.kind === 'indices' ? new Set(request.rows.values) : undefined;
        for await (const block of scope.read(binding.source, {
          kind: 'samples',
          from: binding.from,
          select: [binding.field],
          rows,
          window,
        })) {
          assertIndex(request.index, block.index);
          const column = block.columns[binding.field];
          if (
            !column ||
            !Number.isSafeInteger(column.rowStride) ||
            column.rowStride < 1 ||
            !Number.isSafeInteger(column.frameStride) ||
            column.frameStride < 1
          )
            throw failure('invalid-input', 'Invalid sampled extent column');
          const count = rowCount(block.rows);
          const last =
            column.offset +
            (count - 1) * column.rowStride +
            (block.coordinates.length - 1) * column.frameStride;
          if (
            count &&
            block.coordinates.length &&
            (last >= column.values.length || last - column.offset >= column.length)
          )
            throw failure('invalid-input', 'Sample column does not cover its axes');
          for (let i = 0; i < count; i++) {
            const row = rowAt(block.rows, i);
            if (
              request.rows.kind === 'range'
                ? row < request.rows.offset || row >= request.rows.offset + request.rows.count
                : !selected!.has(row)
            )
              continue;
            for (let f = 0; f < block.coordinates.length; f++) {
              const at = column.offset + i * column.rowStride + f * column.frameStride;
              if (bitAt(column.validity, at)) include(column.values[at]);
            }
          }
        }
      } else {
        const read = await this.resolve(
          group,
          request.index,
          request.rows,
          window?.kind === 'at' ? { ...scope, at: window.value } : scope,
        );
        try {
          const gathered = this.assemble(read, request.rows, group);
          try {
            scan(
              gathered.columns[binding.field],
              rowCount(request.rows),
              gathered.presence[binding.field],
            );
          } finally {
            gathered.entry.unpin();
          }
        } finally {
          read.entry.unpin();
        }
      }
      scope.signal.throwIfAborted();
      const value: Domain | null = lo <= hi ? [lo, hi] : null;
      const entry = this.memory.add([], 128 + key.length * 2, () => {
        if (state.extents.get(key)?.entry === entry) state.extents.delete(key);
      });
      state.extents.set(key, { entry, from: binding.from, sampled, value });
      scope.use(entry);
      entry.unpin();
      return value;
    } finally {
      state.entry.unpin();
    }
  }

  private schemaState(source: Data, signal: AbortSignal): SchemaState {
    signal.throwIfAborted();
    let state = this.schemas.get(source.schema);
    if (state?.entry.live) {
      state.entry.pin();
      return state;
    }
    const schema = source.schema;
    const entry = this.memory.add([], 256 + JSON.stringify(schema).length * 2, () => {});
    state = { schema, entry, cache: new Map(), byField: new Map(), extents: new Map() };
    this.schemas.set(source.schema, state);
    return state;
  }

  private lookup(group: Group, index: Index, rows: RowAxis, at?: number): Cached | ColumnRead {
    const selected = intersectSelection(rows, group.rows, index),
      fields = [...group.fields.keys()].sort();
    const table = this.keys.table(group.source, group.from);
    const window =
      group.sampled && at !== undefined ? { kind: 'at' as const, value: at } : undefined;
    const dependencies = Object.fromEntries(
      fields.map((name) => [name, this.keys.field(group.source, group.from, name, window)]),
    );
    const key = JSON.stringify([
      table,
      index,
      this.keys.axis(rows),
      this.keys.selection(group.rows),
      dependencies,
      group.sampled ? (window ? 'at' : 'missing-coordinate') : 'static',
    ]);
    let hit = group.state.cache.get(key);
    if (!hit)
      for (const cached of group.state.byField.get(
        readKey(table, fields[0], dependencies[fields[0]]),
      ) ?? []) {
        if (
          cached.entry.live &&
          cached.from === group.from &&
          cached.sampled === group.sampled &&
          cached.table === table &&
          fields.every((name) => cached.dependencies[name] === dependencies[name]) &&
          cached.selection.kind !== 'ids' &&
          selected.kind !== 'ids' &&
          fields.every((name) => name in cached.expected) &&
          contiguous(cached.selection, selected) !== undefined &&
          cached.index.source === index.source &&
          cached.index.version === index.version
        ) {
          hit = cached;
          break;
        }
      }
    if (hit?.entry.live) {
      hit.entry.pin();
      this.memory.queryHits++;
      return hit;
    }
    return { group, index, rows, selected, fields, table, dependencies, key };
  }
  private async resolve(
    group: Group,
    index: Index,
    rows: RowAxis,
    scope: FieldScope,
  ): Promise<Cached> {
    return (await this.resolveAll([group], index, rows, scope)).get(group)!;
  }
  private async resolveAll(
    groups: readonly Group[],
    index: Index,
    rows: RowAxis,
    scope: FieldScope,
  ): Promise<Map<Group, Cached>> {
    const resolved = new Map<Group, Cached>();
    const batches = new Map<string, ColumnRead[]>();
    try {
      for (const group of groups) {
        // Only a sampled read consults the coordinate, so a recording scope learns it depends on it.
        const found = this.lookup(group, index, rows, group.sampled ? scope.at : undefined);
        if ('entry' in found) {
          resolved.set(group, found);
          continue;
        }
        const key = JSON.stringify([
          this.keys.id(group.source),
          group.from,
          group.sampled,
          this.keys.selection(group.rows),
        ]);
        let batch = batches.get(key);
        if (!batch) batches.set(key, (batch = []));
        batch.push(found);
      }
      // Share each cold read across compatible columns, while caching each dependency separately.
      for (const batch of batches.values()) {
        const { group, selected } = batch[0];
        const fields = [...new Set(batch.flatMap((read) => read.fields))];
        const chunks: RowsBlock[] = [],
          held: Entry[] = [];
        try {
          if (selected.kind === 'ids' || rowCount(selected)) {
            for await (const block of scope.read(group.source, {
              kind: 'rows',
              from: group.from,
              select: fields,
              rows: selected,
              ...(group.sampled ? { at: scope.at } : {}),
            })) {
              assertIndex(index, block.index);
              for (const field of fields) {
                const column = block.columns[field];
                if (!column) throw failure('invalid-input', 'Query omitted a requested field');
                validateNative(column, rowCount(block.rows));
              }
              held.push(this.memory.add(blockBuffers(block), 128, () => {}));
              chunks.push(block);
            }
          }
          for (const read of batch) {
            const columns =
              batch.length === 1
                ? chunks
                : chunks.map((block) => ({
                    ...block,
                    columns: Object.fromEntries(
                      read.fields.map((name) => [name, block.columns[name]]),
                    ),
                  }));
            resolved.set(read.group, this.storeRead(read, columns));
          }
        } finally {
          for (const entry of held) this.memory.remove(entry);
        }
      }
      return resolved;
    } catch (error) {
      for (const read of resolved.values()) read.entry.unpin();
      throw error;
    }
  }
  private storeRead(read: ColumnRead, chunks: RowsBlock[]): Cached {
    const { group, index, rows, selected, fields, table, dependencies, key } = read;
    const definition = group.state.schema.types[group.from];
    const expected = Object.fromEntries(
      fields.map((field) => {
        const type = definition!.fields[field].type;
        if (typeof type === 'object' && type.kind === 'reference')
          throw failure(
            'unsupported',
            'Fields require numeric, vector, boolean, text, or list data',
          );
        return [field, emptyColumn(type)];
      }),
    );
    const state = group.state;
    const related = fields.map((field) => readKey(table, field, dependencies[field]));
    state.entry.pin();
    let entry: Entry;
    try {
      entry = this.memory.add(
        blockBuffers({ rows, chunks, selection: selected }),
        256 + key.length * 2 + related.reduce((n, key) => n + key.length * 2 + 128, 0),
        () => {
          if (state.cache.get(key)?.entry === entry) state.cache.delete(key);
          for (const name of related) {
            const reads = state.byField.get(name);
            reads?.delete(result);
            if (!reads?.size) state.byField.delete(name);
          }
          state.entry.unpin();
        },
      );
    } catch (error) {
      state.entry.unpin();
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
      table,
      dependencies,
    };
    state.cache.set(key, result);
    for (const name of related) {
      let reads = state.byField.get(name);
      if (!reads) state.byField.set(name, (reads = new Set()));
      reads.add(result);
    }
    return result;
  }

  private assemble(read: Cached, rows: RowAxis, group: Group): Resolved {
    const key =
      'read:' +
      this.keys.id(read) +
      ':' +
      JSON.stringify([this.keys.axis(rows), [...group.fields.keys()].sort()]);
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
    const entry = this.memory.add(blockBuffers(tile), 256 + key.length * 2, () =>
      this.tiles.delete(key),
    );
    this.tiles.set(key, { entry, tile });
    return { ...result, entry };
  }

  private local(input: FieldValues, rows: RowAxis): Resolved {
    validateNative(input.values, rowCount(input.rows));
    const key =
      'local:' +
      this.keys.id(input.values) +
      ':' +
      JSON.stringify([this.keys.axis(input.rows), this.keys.axis(rows)]);
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
    const entry = this.memory.add(blockBuffers(tile), 256, () => this.tiles.delete(key));
    this.tiles.set(key, { entry, tile });
    return { ...result, entry };
  }
}

async function aggregateExtent(
  scope: FieldScope,
  binding: FieldBinding,
  rows: RowSelection | undefined,
  window: SampleWindow | undefined,
): Promise<Domain | null> {
  let extent: Domain | null | undefined;
  for await (const block of scope.read(binding.source, {
    kind: 'aggregate',
    from: binding.from,
    select: [binding.field],
    ...(rows ? { rows } : {}),
    measures: ['min', 'max'],
    ...(window ? { window } : {}),
  })) {
    const value = block.values[binding.field];
    if (!value || extent !== undefined)
      throw failure('invalid-input', 'Aggregate must return each field exactly once');
    if (
      value.count &&
      (value.min == null ||
        value.max == null ||
        !Number.isFinite(value.min) ||
        !Number.isFinite(value.max) ||
        value.min > value.max)
    )
      throw failure('invalid-input', 'Invalid aggregate extent');
    extent = value.count ? [value.min!, value.max!] : null;
  }
  if (extent === undefined) throw failure('invalid-input', 'Aggregate omitted its field');
  return extent;
}
function readKey(table: string, field: string, dependency: string): string {
  return JSON.stringify([table, field, dependency]);
}
function intersectSelection(
  rows: RowAxis,
  selected: RowSelection | undefined,
  index: Index,
): RowSelection {
  if (!selected) return { ...rows, index };
  if (selected.kind === 'ids') return selected;
  if (selected.index) assertIndex(index, selected.index);
  return { ...intersect(rows, selected), index };
}

/** Whether every row is present. A missing row the draw requires is an error. */
function covered(
  present: Uint8Array,
  rows: RowAxis,
  partial: boolean,
  required?: RowAxis,
): boolean {
  let complete = true;
  for (let i = 0, n = rowCount(rows); i < n; i++)
    if (!bitAt(present, i)) {
      complete = false;
      if (!partial || (required && position(required, rowAt(rows, i)) >= 0))
        throw failure('invalid-input', 'Query did not cover the requested draw rows');
    }
  return complete;
}

function assemble(
  rows: RowAxis,
  fields: string[],
  chunks: readonly Pick<RowsBlock, 'rows' | 'columns'>[],
  partial: boolean,
  memory: Memory,
  expected: Record<string, Column> = {},
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
      if (!column) throw failure('invalid-input', 'Query omitted a requested field');
      columns[name] =
        offset === 0 && column.length === count
          ? column
          : { ...column, offset: column.offset + offset, length: count };
    }
    return { columns, presence };
  }
  const positions = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const row = rowAt(rows, i),
      list = positions.get(row) ?? [];
    list.push(i);
    positions.set(row, list);
  }
  const maskBytes = Math.ceil(count / 8);
  for (const name of fields) {
    const sample = chunks.find((chunk) => chunk.columns[name])?.columns[name] ?? expected[name];
    if (sample?.kind === 'text' || sample?.kind === 'list') {
      // Variable-length values gather through the model's one gather, item runs included.
      const cells = new Array<Cell | undefined>(count);
      const present = new Uint8Array(maskBytes);
      let items = 0;
      for (const chunk of chunks) {
        const column = chunk.columns[name];
        if (
          column?.kind !== sample.kind ||
          (column.kind === 'list' && column.values.kind !== (sample as typeof column).values.kind)
        )
          throw failure('conflict', 'Field type changed across blocks');
        for (let i = 0; i < rowCount(chunk.rows); i++)
          for (const target of positions.get(rowAt(chunk.rows, i)) ?? []) {
            if (bitAt(present, target))
              throw failure('invalid-input', 'Query returned a physical row twice');
            setBit(present, target);
            const at = column.offset + i;
            if (bitAt(column.validity, at)) items += column.offsets[at + 1] - column.offsets[at];
            cells[target] = { column, at: i };
          }
      }
      const complete = covered(present, rows, partial, required);
      columns[name] = memory.stage((count + 1) * 4 + maskBytes + items * 32, () =>
        gather(cells, sample),
      );
      if (!complete) presence[name] = present;
      continue;
    }
    if (
      sample &&
      sample.kind !== 'numeric' &&
      sample.kind !== 'vector' &&
      sample.kind !== 'boolean'
    )
      throw failure('unsupported', 'Fields require numeric, vector, boolean, text, or list data');
    const numeric = sample as Numeric | undefined,
      components = numeric?.kind === 'vector' ? numeric.size : 1;
    const scalar = numeric?.kind === 'vector' ? numeric.values : numeric;
    const size = count * components;
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
        if (!column) throw failure('invalid-input', 'Query omitted a requested field');
        if (
          numeric &&
          (column.kind !== numeric.kind || (column.kind === 'vector' && column.size !== components))
        )
          throw failure('conflict', 'Field type changed across query blocks');
        for (let i = 0; i < rowCount(chunk.rows); i++)
          for (const target of positions.get(rowAt(chunk.rows, i)) ?? []) {
            if (bitAt(present, target))
              throw failure('invalid-input', 'Query returned a physical row twice');
            setBit(present, target);
            const at = column.offset + i;
            if (!bitAt(column.validity, at)) {
              hasNull = true;
              continue;
            }
            setBit(valid, target);
            if (column.kind === 'boolean') {
              if (bitAt(column.values, at)) setBit(values as Uint8Array, target);
            } else if (column.kind === 'vector')
              for (let lane = 0; lane < components; lane++)
                values[target * components + lane] =
                  column.values.values[column.values.offset + at * components + lane];
            else values[target] = column.values[at];
          }
      }
      const complete = covered(present, rows, partial, required);
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

function validateNative(column: Column, rows: number): void {
  if (!column || !Number.isSafeInteger(column.offset) || column.offset < 0 || column.length < rows)
    throw failure('invalid-input', 'Column does not cover its rows');
}
function sliceBits(mask: Uint8Array, offset: number, count: number): Uint8Array {
  if (offset % 8 === 0) return mask.subarray(offset / 8, Math.ceil((offset + count) / 8));
  const result = new Uint8Array(Math.ceil(count / 8));
  for (let i = 0; i < count; i++) if (bitAt(mask, offset + i)) setBit(result, i);
  return result;
}
function joinSamples(
  anchor: SamplesBlock,
  chunks: readonly SamplesBlock[],
  names: readonly string[],
  partial: boolean,
  memory: Memory,
  required?: RowAxis,
): { columns: Record<string, SampleColumn>; presence: Record<string, Uint8Array> } {
  const rows = rowCount(anchor.rows),
    frames = anchor.coordinates.length;
  if (
    chunks.length === 1 &&
    chunks[0].firstFrame === anchor.firstFrame &&
    chunks[0].coordinates.length === frames &&
    contiguous(chunks[0].rows, anchor.rows) === 0 &&
    rowCount(chunks[0].rows) === rows
  ) {
    for (let f = 0; f < frames; f++)
      if (chunks[0].coordinates[f] !== anchor.coordinates[f])
        throw failure('conflict', 'Sample coordinates differ across bindings');
    return { columns: { ...chunks[0].columns }, presence: {} };
  }
  return memory.stage(rows * frames * names.length * 10 + rows * 16, () => {
    const positions = new Map<number, number>();
    for (let i = 0; i < rows; i++) positions.set(rowAt(anchor.rows, i), i);
    const columns: Record<string, SampleColumn> = {},
      presence: Record<string, Uint8Array> = {};
    for (const name of names) {
      const prototype = chunks[0]?.columns[name];
      const Constructor = (prototype?.values.constructor ?? Float64Array) as {
        new (length: number): NumericArray;
      };
      const values = new Constructor(rows * frames),
        validity = new Uint8Array(Math.ceil((rows * frames) / 8)),
        seen = new Uint8Array(validity.length),
        covers = new Uint32Array(rows);
      for (const chunk of chunks) {
        const column = chunk.columns[name];
        if (!column) throw failure('invalid-input', 'Sample query omitted a field');
        for (let f = 0; f < chunk.coordinates.length; f++) {
          const targetFrame = chunk.firstFrame + f - anchor.firstFrame;
          if (
            targetFrame < 0 ||
            targetFrame >= frames ||
            chunk.coordinates[f] !== anchor.coordinates[targetFrame]
          )
            throw failure('conflict', 'Sample coordinates differ across bindings');
          for (let r = 0; r < rowCount(chunk.rows); r++) {
            const targetRow = positions.get(rowAt(chunk.rows, r));
            if (targetRow === undefined) continue;
            const to = targetFrame * rows + targetRow,
              from = column.offset + f * column.frameStride + r * column.rowStride;
            if (bitAt(seen, to)) throw failure('invalid-input', 'Overlapping sample tiles');
            setBit(seen, to);
            covers[targetRow]++;
            if (bitAt(column.validity, from)) {
              setBit(validity, to);
              values[to] = column.values[from];
            }
          }
        }
      }
      const mask = new Uint8Array(Math.ceil(rows / 8));
      let complete = true;
      for (let r = 0; r < rows; r++) {
        if (covers[r] === frames) setBit(mask, r);
        else if (
          covers[r] ||
          !partial ||
          (required && position(required, rowAt(anchor.rows, r)) >= 0)
        )
          throw failure('invalid-input', 'Sample query did not cover its requested rectangle');
        else complete = false;
      }
      columns[name] = {
        kind: 'numeric',
        offset: 0,
        length: values.length,
        values,
        validity,
        frameStride: rows,
        rowStride: 1,
      };
      if (!complete) presence[name] = mask;
    }
    return { columns, presence };
  });
}

const tileExtents = new WeakMap<object, { key: string; value: Domain | null }>();
function tileExtent(tile: FieldsBlock, name: string): Domain | null {
  const column = tile.columns[name];
  if (column.kind !== 'numeric')
    throw failure('invalid-input', 'Scales require scalar numeric fields');
  const sampled = column as SampleColumn,
    rows = rowCount(tile.rows),
    frames = tile.samples?.coordinates.length ?? 1;
  const mask = tile.presence[name];
  // Cache only complete columns: partial overlays have independent presence masks.
  const key = [
    column.offset,
    column.length,
    rows,
    frames,
    sampled.rowStride,
    sampled.frameStride,
  ].join(':');
  const cache = tileExtents.get(column);
  if (!mask && cache?.key === key) return cache.value;
  let lo = Infinity,
    hi = -Infinity;
  for (let row = 0; row < rows; row++) {
    if (!bitAt(mask, row)) continue;
    for (let frame = 0; frame < frames; frame++) {
      const at =
          column.offset + row * (sampled.rowStride ?? 1) + frame * (sampled.frameStride ?? 0),
        value = column.values[at];
      if (bitAt(column.validity, at) && Number.isFinite(value)) {
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    }
  }
  const result: Domain | null = lo <= hi ? [lo, hi] : null;
  if (!mask) tileExtents.set(column, { key, value: result });
  return result;
}
