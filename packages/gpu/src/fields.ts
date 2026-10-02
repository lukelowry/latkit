import { DataKeys } from './data-keys.js';
import { resolveScale } from './scale.js';
import {
  blockBuffers,
  type Column,
  type FieldDefinition,
  type NumericArray,
  type Data,
  type RowAxis,
  type RowSelection,
  type RowsBlock,
  type Schema,
} from '@latkit/model';
import { assertIndex, rowAt, rowCount, sliceRows } from '@latkit/model';
import { type FieldBinding, type FieldsRequest, type FieldValues } from './binding.js';
import type { NativeFields } from './binding.js';
import type { Index, SamplesBlock, SampleColumn, SampleWindow } from '@latkit/model';
import { GpuError } from './error.js';
import type { Entry, Memory } from './memory.js';
import type { Preparation } from './render.js';
import type { UploadScope } from './uploads.js';

type Numeric = Exclude<FieldValues['values'], { kind: 'list' | 'text' }>;
type FieldColumn = FieldValues['values'];
interface IndexedFields {
  readonly source: Data;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly fields: FieldsRequest['fields'];
}
type ReadFrame = Pick<Preparation, 'query' | 'signal' | 'at'> & {
  observe(source: Data): void;
};
interface Resolved {
  columns: Record<string, Column>;
  presence: Record<string, Uint8Array>;
  entry: Entry;
}
interface Cached {
  index: Index;
  chunks: RowsBlock[];
  expected: Record<string, FieldColumn>;
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
  value: import('@latkit/model').Domain | null;
}
interface SchemaState {
  schema: Schema;
  entry: Entry;
  cache: Map<string, Cached>;
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
interface Tile {
  index: Index;
  rows: RowAxis;
  columns: Record<string, Column>;
  presence: Record<string, Uint8Array>;
}

/** Resolves native fields into one physical row order. Uploading remains the Uploader's job. */
export class Fields {
  private schemas = new WeakMap<Schema, SchemaState>();
  private readonly keys = new DataKeys();
  private ids = new WeakMap<object, number>();
  private serial = 0;
  private tiles = new Map<string, { entry: Entry; tile: Tile }>();
  constructor(
    private readonly memory: Memory,
    private readonly tileBytes: number,
  ) {}

  async *prepare(
    request: FieldsRequest,
    frame: ReadFrame,
    scope: UploadScope,
  ): AsyncGenerator<NativeFields> {
    if (!request.from) throw new GpuError('invalid-input', 'Fields require a model type');
    if (request.window) {
      yield* this.sampled(request, frame, scope);
      return;
    }
    if (request.rows && request.rows.kind !== 'ids' && request.rows.index && !request.ids) {
      if (request.rows.index.type !== request.from)
        throw new GpuError('conflict', 'Selection belongs to another type');
      yield* this.indexed(
        { ...request, index: request.rows.index, rows: request.rows },
        frame,
        scope,
      );
      return;
    }
    // Discover physical identity from a real read, never from a schema or a guessed row count.
    const selected = new Map<string, string[]>();
    for (const [alias, input] of Object.entries(request.fields)) {
      const field =
        typeof input === 'string'
          ? input
          : 'field' in input &&
              input.source === request.source &&
              input.from === request.from &&
              !input.rows
            ? input.field
            : undefined;
      if (field) selected.set(field, [...(selected.get(field) ?? []), alias]);
    }
    const state = this.schemaState(request.source, frame.signal);
    const definition = state.schema.types[request.from];
    const sampled = [...selected.keys()].some((field) => definition?.fields[field]?.sampled);
    try {
      for await (const block of frame.query(request.source, {
        kind: 'rows',
        from: request.from,
        rows: request.rows,
        select: [...selected.keys()],
        ...(request.ids ? { ids: true } : {}),
        ...(sampled ? { at: frame.at } : {}),
      })) {
        if (block.kind === 'schema') continue;
        const held = this.memory.add(blockBuffers(block), 128, () => {});
        try {
          const fields = { ...request.fields };
          for (const [field, aliases] of selected)
            for (const alias of aliases)
              fields[alias] = {
                index: block.index,
                rows: block.rows,
                values: block.columns[field],
              };
          for await (const tile of this.indexed(
            { source: request.source, index: block.index, rows: block.rows, fields },
            frame,
            scope,
          )) {
            const ids = block.ids && {
              ...block.ids,
              offset: block.ids.offset + tile.rowOffset,
              length: rowCount(tile.rows),
            };
            yield this.native(
              { ...tile, rowOffset: block.position + tile.rowOffset, ...(ids ? { ids } : {}) },
              frame.signal,
            );
          }
        } finally {
          this.memory.remove(held);
        }
      }
    } finally {
      state.entry.unpin();
    }
  }

  private native(tile: Omit<NativeFields, 'versions'>, signal: AbortSignal): NativeFields {
    signal.throwIfAborted();
    return {
      ...tile,
      versions: new Map(),
    };
  }

  private async *sampled(
    request: FieldsRequest,
    frame: ReadFrame,
    scope: UploadScope,
  ): AsyncGenerator<NativeFields> {
    const groups: {
      source: Data;
      from: string;
      fields: Map<string, string[]>;
      rows?: RowSelection;
    }[] = [];
    const statics: Record<string, import('./binding.js').FieldInput> = {};
    for (const [alias, input] of Object.entries(request.fields)) {
      if (typeof input === 'object' && 'values' in input) {
        statics[alias] = input;
        continue;
      }
      const binding: FieldBinding =
        typeof input === 'string'
          ? { source: request.source, from: request.from, field: input }
          : input;
      if (binding.from !== request.from)
        throw new GpuError('conflict', 'Fields must belong to one model type');
      const state = this.schemaState(binding.source, frame.signal);
      try {
        const definition = state.schema.types[binding.from];
        const field = definition?.fields[binding.field];
        if (!field) throw new GpuError('invalid-input', 'Unknown field: ' + binding.field);
        if (!field.sampled) {
          statics[alias] = input;
          continue;
        }
        let group = groups.find(
          (g) =>
            g.source === binding.source &&
            this.selectionKey(g.rows) === this.selectionKey(binding.rows),
        );
        if (!group) {
          group = {
            source: binding.source,
            from: binding.from,
            fields: new Map(),
            rows: binding.rows,
          };
          groups.push(group);
        }
        group.fields.set(binding.field, [...(group.fields.get(binding.field) ?? []), alias]);
      } finally {
        state.entry.unpin();
      }
    }
    if (!groups.length)
      throw new GpuError('invalid-input', 'A sample window requires sampled fields');
    const anchor = groups.find((g) => !g.rows);
    if (!anchor)
      throw new GpuError('invalid-input', 'A sampled read requires one complete field binding');
    for await (const block of frame.query(anchor.source, {
      kind: 'samples',
      from: request.from,
      rows: request.rows,
      select: [...anchor.fields.keys()],
      window: request.window!,
    })) {
      if (block.kind === 'schema') continue;
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
          const selected = intersect(block.rows, group.rows, block.index);
          try {
            for await (const part of frame.query(group.source, {
              kind: 'samples',
              from: request.from,
              rows: selected,
              select: [...group.fields.keys()],
              window: { kind: 'frames', offset: block.firstFrame, count: block.coordinates.length },
            })) {
              if (part.kind === 'schema') continue;
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
            joined.push(this.memory.add(backings(merged), 128, () => {}));
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
          frame,
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
          let ids: import('@latkit/model').TextColumn | undefined;
          let identityEntry: Entry | undefined;
          if (request.ids) {
            const chunks: RowsBlock[] = [],
              heldIds: Entry[] = [];
            try {
              for await (const part of frame.query(request.source, {
                kind: 'rows',
                from: request.from,
                rows: { ...tile.rows, index: tile.index },
                select: [],
                ids: true,
              })) {
                if (part.kind === 'schema') continue;
                assertIndex(tile.index, part.index);
                if (!part.ids) throw new GpuError('invalid-input', 'Identity query omitted ids');
                heldIds.push(this.memory.add(blockBuffers(part), 128, () => {}));
                chunks.push({ ...part, columns: { ids: part.ids } });
              }
              ids = assemble(tile.rows, ['ids'], chunks, false, this.memory).columns
                .ids as import('@latkit/model').TextColumn;
              identityEntry = this.memory.add(backings(ids), 128, () => {});
            } finally {
              for (const entry of heldIds) this.memory.remove(entry);
            }
          }
          try {
            const data = {
              ...tile,
              rowOffset: block.rowOffset + tile.rowOffset,
              columns,
              presence,
              ...(ids ? { ids } : {}),
              samples: { firstFrame: block.firstFrame, coordinates: block.coordinates },
            };
            const entry = this.memory.add(backings(data), 128, () => {});
            try {
              yield this.native(data, frame.signal);
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
  }

  private async *indexed(
    request: IndexedFields,
    frame: ReadFrame,
    scope: UploadScope,
  ): AsyncGenerator<NativeFields> {
    const count = rowCount(request.rows),
      names = Object.keys(request.fields);
    if (!count) return;
    const states = new Map<Data, SchemaState>();
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
          state = this.schemaState(binding.source, frame.signal);
          states.set(binding.source, state);
          scope.use(state.entry);
        }
        const definition = state.schema.types[binding.from];
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
        Math.floor(Math.min(this.tileBytes, this.memory.budget.stagingBytes / 2) / width),
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
                yield this.native(
                  {
                    index: request.index,
                    rows: selected,
                    rowOffset: offset + sorted[part - 1],
                    columns: cached.tile.columns,
                    presence: cached.tile.presence,
                  },
                  frame.signal,
                );
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

  async scale(
    request: import('./scale.js').ScaleRequest,
    frame: ReadFrame,
    scope: UploadScope,
  ): Promise<import('./scale.js').ResolvedScale> {
    if (Array.isArray(request.domain))
      return resolveScale(request, request.domain as import('@latkit/model').Domain);
    const window =
      request.domain && request.domain !== 'auto'
        ? (request.domain as { window: SampleWindow }).window
        : request.window;
    if (request.rows && request.rows.kind !== 'ids' && request.rows.index) {
      return resolveScale(
        request,
        await this.extent(
          {
            source: request.source,
            index: request.rows.index,
            rows: request.rows,
            field: request.field,
            window,
          },
          frame,
          scope,
        ),
      );
    }
    let lo = Infinity,
      hi = -Infinity;
    for await (const tile of this.prepare(
      {
        source: request.source,
        from: request.from,
        rows: request.rows,
        fields: { value: request.field },
        window,
      },
      frame,
      scope,
    )) {
      const extent = nativeExtent(tile, 'value');
      if (extent) {
        lo = Math.min(lo, extent[0]);
        hi = Math.max(hi, extent[1]);
      }
    }
    return resolveScale(request, lo <= hi ? [lo, hi] : null);
  }

  async extent(
    request: import('./binding.js').ExtentRequest,
    frame: Pick<Preparation, 'query' | 'signal' | 'at'> & { observe(source: Data): void },
    scope: UploadScope,
  ): Promise<import('@latkit/model').Domain | null> {
    frame.signal.throwIfAborted();
    const input = request.field;
    let lo = Infinity,
      hi = -Infinity;
    const include = (value: number) => {
      if (Number.isFinite(value)) {
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    };
    const scan = (column: Column, count: number, presence?: Uint8Array, stride = 1, start = 0) => {
      if (column.kind !== 'numeric')
        throw new GpuError('invalid-input', 'Extents require scalar numeric fields');
      for (let i = 0; i < count; i++) {
        const at = column.offset + start + i * stride;
        if (bit(presence, i) && bit(column.validity, at)) include(column.values[at]);
      }
    };
    if (typeof input === 'object' && 'values' in input) {
      if (request.window) throw new GpuError('invalid-input', 'Local values have no sample window');
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
      throw new GpuError('invalid-input', 'String fields require a source');
    const binding: FieldBinding =
      typeof input === 'string'
        ? { source: request.source!, from: request.index.type, field: input }
        : input;
    if (binding.from !== request.index.type)
      throw new GpuError('conflict', 'Extent field must belong to the selected index');
    frame.observe(binding.source);
    const state = this.schemaState(binding.source, frame.signal);
    try {
      scope.use(state.entry);
      const definition = state.schema.types[binding.from];
      const field = definition?.fields[binding.field];
      if (!field || !['float32', 'float64', 'int32', 'uint32'].includes(field.type as string))
        throw new GpuError('invalid-input', 'Extents require scalar numeric fields');
      const sampled = field.sampled === true;
      if (request.window && !sampled)
        throw new GpuError('invalid-input', 'Static fields have no sample window');
      const window =
        request.window ??
        (sampled && frame.at !== undefined ? { kind: 'at' as const, value: frame.at } : undefined);
      if (sampled && !window)
        throw new GpuError('invalid-input', 'Sampled extents require a coordinate or window');
      const rows = intersect(request.rows, binding.rows, request.index);
      const table = this.keys.table(binding.source, binding.from);
      const dependency = this.keys.field(binding.source, binding.from, binding.field, window);
      const key = JSON.stringify([
        table,
        request.index,
        this.axisKey(request.rows),
        this.selectionKey(binding.rows),
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
      {
        const native =
          !request.window &&
          [...state.cache.values()].find(
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
        if (native) {
          const group: Group = {
            source: binding.source,
            state,
            from: binding.from,
            sampled,
            rows: binding.rows,
            fields: new Map([[binding.field, ['value']]]),
          };
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
          let seen = false;
          for await (const block of frame.query(binding.source, {
            kind: 'aggregate',
            from: binding.from,
            select: [binding.field],
            rows,
            measures: ['min', 'max'],
            ...(window ? { window } : {}),
          })) {
            if (block.kind === 'schema') continue;
            const value = block.values[binding.field];
            if (!value || seen)
              throw new GpuError('invalid-input', 'Aggregate must return each field exactly once');
            seen = true;
            if (value.count) {
              if (
                value.min == null ||
                value.max == null ||
                !Number.isFinite(value.min) ||
                !Number.isFinite(value.max) ||
                value.min > value.max
              )
                throw new GpuError('invalid-input', 'Invalid aggregate extent');
              include(value.min);
              include(value.max);
            }
          }
          if (!seen) throw new GpuError('invalid-input', 'Aggregate omitted its field');
        } else if (window && window.kind !== 'at') {
          // Window reads use the same native scalar/stride rules as field uploads.
          for await (const block of frame.query(binding.source, {
            kind: 'samples',
            from: binding.from,
            select: [binding.field],
            rows,
            window,
          })) {
            if (block.kind === 'schema') continue;
            assertIndex(request.index, block.index);
            const column = block.columns[binding.field];
            if (
              !column ||
              !Number.isSafeInteger(column.rowStride) ||
              column.rowStride < 1 ||
              !Number.isSafeInteger(column.frameStride) ||
              column.frameStride < 1
            )
              throw new GpuError('invalid-input', 'Invalid sampled extent column');
            const count = rowCount(block.rows),
              selected = request.rows.kind === 'indices' ? new Set(request.rows.values) : undefined;
            const last =
              column.offset +
              (count - 1) * column.rowStride +
              (block.coordinates.length - 1) * column.frameStride;
            if (
              count &&
              block.coordinates.length &&
              (last >= column.values.length || last - column.offset >= column.length)
            )
              throw new GpuError('invalid-input', 'Sample column does not cover its axes');
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
                if (bit(column.validity, at)) include(column.values[at]);
              }
            }
          }
        } else {
          const group: Group = {
            source: binding.source,
            state,
            from: binding.from,
            rows: binding.rows,
            sampled,
            fields: new Map([[binding.field, ['value']]]),
          };
          const read = await this.resolve(
            group,
            request.index,
            request.rows,
            window?.kind === 'at' ? { ...frame, at: window.value } : frame,
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
        frame.signal.throwIfAborted();
        const value: import('@latkit/model').Domain | null = lo <= hi ? [lo, hi] : null;
        const entry = this.memory.add([], 128 + key.length * 2, () => {
          if (state.extents.get(key)?.entry === entry) state.extents.delete(key);
        });
        state.extents.set(key, { entry, from: binding.from, sampled, value });
        scope.use(entry);
        entry.unpin();
        return value;
      }
    } finally {
      state.entry.unpin();
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
  private schemaState(source: Data, signal: AbortSignal): SchemaState {
    signal.throwIfAborted();
    let state = this.schemas.get(source.schema);
    if (state?.entry.live) {
      state.entry.pin();
      return state;
    }
    const schema = source.schema;
    const entry = this.memory.add([], 256 + JSON.stringify(schema).length * 2, () => {});
    state = { schema, entry, cache: new Map(), extents: new Map() };
    this.schemas.set(source.schema, state);
    return state;
  }

  private async resolve(
    group: Group,
    index: Index,
    rows: RowAxis,
    frame: Pick<Preparation, 'query' | 'signal' | 'at'>,
  ): Promise<Cached> {
    const selected = intersect(rows, group.rows, index),
      fields = [...group.fields.keys()].sort();
    const table = this.keys.table(group.source, group.from);
    const window =
      group.sampled && frame.at !== undefined
        ? { kind: 'at' as const, value: frame.at }
        : undefined;
    const dependencies = Object.fromEntries(
      fields.map((name) => [name, this.keys.field(group.source, group.from, name, window)]),
    );
    const key = JSON.stringify([
      table,
      index,
      this.axisKey(rows),
      this.selectionKey(group.rows),
      dependencies,
      group.sampled ? (window ? 'at' : 'missing-coordinate') : 'static',
    ]);
    let hit = group.state.cache.get(key);
    if (!hit)
      for (const cached of group.state.cache.values()) {
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
    const chunks: RowsBlock[] = [],
      held: Entry[] = [];
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
            continue;
          }
          assertIndex(index, block.index);
          for (const field of fields) {
            const column = block.columns[field];
            if (!column) throw new GpuError('invalid-input', 'Query omitted a requested field');
            validateNative(column, rowCount(block.rows));
          }
          const entry = this.memory.add(blockBuffers(block), 128, () => {});
          held.push(entry);
          chunks.push(block);
        }
      }
      const definition = group.state.schema.types[group.from];
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
        table,
        dependencies,
      };
      group.state.cache.set(key, result);
      return result;
    } finally {
      for (const entry of held) this.memory.remove(entry);
    }
  }

  private assemble(read: Cached, rows: RowAxis, group: Group): Resolved {
    const key =
      'read:' +
      this.id(read) +
      ':' +
      JSON.stringify([this.axisKey(rows), [...group.fields.keys()].sort()]);
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
    validateNative(input.values, rowCount(input.rows));
    const key =
      'local:' +
      this.id(input.values) +
      ':' +
      JSON.stringify([this.axisKey(input.rows), this.axisKey(rows)]);
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

function definitionBytes(field: FieldDefinition): number {
  const type = field.type;
  if (typeof type === 'object' && type.kind === 'list') {
    definitionBytes({ type: type.items });
    return 17;
  }
  if (typeof type === 'object' && type.kind === 'vector') return type.size * 8 + 1;
  if (['float32', 'float64', 'int32', 'uint32', 'boolean'].includes(type as string)) return 9;
  return 17;
}
function bytesPerRow(column: FieldColumn): number {
  if (column.kind === 'text') return 5 + column.bytes.byteLength / Math.max(1, column.length);
  if (column.kind === 'list')
    return 8 + (bytesPerRow(column.values) * column.values.length) / Math.max(1, column.length);
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
function intersect(rows: RowAxis, selected: RowSelection | undefined, index: Index): RowSelection {
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
  expected: Record<string, FieldColumn> = {},
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
    if (sample?.kind === 'text') {
      const gathered = gatherText(rows, name, chunks, positions, partial, memory, required);
      columns[name] = gathered.column;
      if (gathered.presence) presence[name] = gathered.presence;
      continue;
    }
    if (sample?.kind === 'list') {
      const gathered = gatherLists(
        rows,
        name,
        chunks,
        positions,
        partial,
        memory,
        sample,
        required,
      );
      columns[name] = gathered.column;
      if (gathered.presence) presence[name] = gathered.presence;
      continue;
    }
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

function emptyColumn(field: FieldDefinition): FieldColumn {
  const type = field.type;
  if (typeof type === 'object' && type.kind === 'list') {
    const values = emptyColumn({ type: type.items });
    return { kind: 'list', offset: 0, length: 0, offsets: new Int32Array(1), values };
  }
  if (typeof type === 'object' && type.kind === 'reference')
    throw new GpuError('unsupported', 'GPU fields require numeric, vector, or boolean data');
  if (type === 'text')
    return {
      kind: 'text',
      offset: 0,
      length: 0,
      bytes: new Uint8Array(),
      offsets: new Int32Array(1),
    };
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

function gatherLists(
  rows: RowAxis,
  name: string,
  chunks: readonly Pick<RowsBlock, 'rows' | 'columns'>[],
  positions: Map<number, number[]>,
  partial: boolean,
  memory: Memory,
  sample: import('@latkit/model').ListColumn,
  required?: RowAxis,
): { column: FieldColumn; presence?: Uint8Array } {
  const count = rowCount(rows),
    maskBytes = Math.ceil(count / 8);
  return memory.stage(count * 32 + maskBytes * 2 + 4, () => {
    const cells = new Map<number, { column: import('@latkit/model').ListColumn; row: number }>();
    for (const chunk of chunks) {
      const column = chunk.columns[name];
      if (column?.kind !== 'list' || column.values.kind !== sample.values.kind)
        throw new GpuError('conflict', 'List type changed across blocks');
      for (let i = 0; i < rowCount(chunk.rows); i++)
        for (const target of positions.get(rowAt(chunk.rows, i)) ?? []) {
          if (cells.has(target))
            throw new GpuError('invalid-input', 'Query returned a physical row twice');
          cells.set(target, { column, row: column.offset + i });
        }
    }
    const offsets = new Int32Array(count + 1),
      validity = new Uint8Array(maskBytes),
      presence = new Uint8Array(maskBytes);
    const parts: ColumnPart[] = [],
      requiredSet = required?.kind === 'indices' ? new Set(required.values) : undefined;
    let length = 0,
      complete = true,
      nullable = false;
    for (let i = 0; i < count; i++) {
      const cell = cells.get(i),
        row = rowAt(rows, i);
      if (!cell) {
        complete = false;
        if (
          !partial ||
          requiredSet?.has(row) ||
          (required?.kind === 'range' &&
            row >= required.offset &&
            row < required.offset + required.count)
        )
          throw new GpuError('invalid-input', 'Query did not cover the requested draw rows');
      } else {
        mark(presence, i);
        if (!bit(cell.column.validity, cell.row)) nullable = true;
        else {
          mark(validity, i);
          const offset = cell.column.offsets[cell.row],
            count = cell.column.offsets[cell.row + 1] - offset;
          if (count) parts.push({ column: cell.column.values, offset, count });
          length += count;
        }
      }
      if (length > 0x7fffffff) throw new GpuError('resource-limit', 'List offsets exceed int32');
      offsets[i + 1] = length;
    }
    return {
      column: {
        kind: 'list',
        offset: 0,
        length: count,
        offsets,
        values: concatenate(parts, sample.values, length, memory),
        validity: nullable ? validity : undefined,
      },
      presence: complete ? undefined : presence,
    };
  });
}
interface ColumnPart {
  column: Column;
  offset: number;
  count: number;
}
function concatenate(
  parts: readonly ColumnPart[],
  prototype: Column,
  length: number,
  memory: Memory,
): Column {
  if (parts.length === 1)
    return { ...parts[0].column, offset: parts[0].column.offset + parts[0].offset, length };
  const base = { offset: 0, length };
  if (prototype.kind === 'list')
    return memory.stage((length + 1) * 4 + parts.length * 32, () => {
      const offsets = new Int32Array(length + 1),
        children: ColumnPart[] = [];
      let cursor = 0,
        total = 0;
      for (const part of parts) {
        const column = part.column;
        if (column.kind !== 'list') throw new GpuError('conflict', 'Incompatible list items');
        const start = column.offset + part.offset;
        for (let i = 0; i < part.count; i++) {
          total += column.offsets[start + i + 1] - column.offsets[start + i];
          offsets[++cursor] = total;
        }
        children.push({
          column: column.values,
          offset: column.offsets[start],
          count: column.offsets[start + part.count] - column.offsets[start],
        });
      }
      return {
        ...base,
        kind: 'list',
        offsets,
        values: concatenate(children, prototype.values, total, memory),
      };
    });
  if (prototype.kind === 'text') {
    let bytes = 0;
    for (const part of parts) {
      if (part.column.kind !== 'text') throw new GpuError('conflict', 'Incompatible text items');
      const start = part.column.offset + part.offset;
      bytes += part.column.offsets[start + part.count] - part.column.offsets[start];
    }
    return memory.stage(bytes + (length + 1) * 4, () => {
      const values = new Uint8Array(bytes),
        offsets = new Int32Array(length + 1);
      let cursor = 0,
        at = 0;
      for (const part of parts) {
        const column = part.column as import('@latkit/model').TextColumn,
          start = column.offset + part.offset;
        for (let i = 0; i < part.count; i++) {
          const text = column.bytes.subarray(
            column.offsets[start + i],
            column.offsets[start + i + 1],
          );
          values.set(text, at);
          at += text.length;
          offsets[++cursor] = at;
        }
      }
      return { ...base, kind: 'text', bytes: values, offsets };
    });
  }
  const size = prototype.kind === 'vector' ? prototype.size : 1,
    scalar = prototype.kind === 'vector' ? prototype.values : prototype;
  const Constructor = scalar.values.constructor as {
    new (length: number): NumericArray;
    BYTES_PER_ELEMENT: number;
  };
  return memory.stage(
    prototype.kind === 'boolean'
      ? Math.ceil(length / 8)
      : length * size * Constructor.BYTES_PER_ELEMENT,
    () => {
      const values =
        prototype.kind === 'boolean'
          ? new Uint8Array(Math.ceil(length / 8))
          : new Constructor(length * size);
      let cursor = 0;
      for (const part of parts) {
        const column = part.column;
        if (column.kind !== prototype.kind)
          throw new GpuError('conflict', 'Incompatible list items');
        const start = column.offset + part.offset;
        if (column.kind === 'boolean') {
          for (let i = 0; i < part.count; i++)
            if (bit(column.values, start + i)) mark(values as Uint8Array, cursor + i);
        } else if (column.kind === 'numeric')
          values.set(column.values.subarray(start, start + part.count), cursor);
        else if (column.kind === 'vector') {
          if (column.size !== size) throw new GpuError('conflict', 'Incompatible vector items');
          const at = column.values.offset + start * size;
          values.set(column.values.values.subarray(at, at + part.count * size), cursor * size);
        }
        cursor += part.count;
      }
      if (prototype.kind === 'boolean')
        return { ...base, kind: 'boolean', values: values as Uint8Array };
      const numeric = {
        kind: 'numeric' as const,
        offset: 0,
        length: length * size,
        values: values as NumericArray,
      };
      return prototype.kind === 'vector'
        ? { ...base, kind: 'vector', size, values: numeric }
        : numeric;
    },
  );
}

function validateNative(column: Column, rows: number): void {
  if (!column || !Number.isSafeInteger(column.offset) || column.offset < 0 || column.length < rows)
    throw new GpuError('invalid-input', 'Column does not cover its rows');
}
function sliceBits(mask: Uint8Array, offset: number, count: number): Uint8Array {
  if (offset % 8 === 0) return mask.subarray(offset / 8, Math.ceil((offset + count) / 8));
  const result = new Uint8Array(Math.ceil(count / 8));
  for (let i = 0; i < count; i++) if (bit(mask, offset + i)) mark(result, i);
  return result;
}
function gatherText(
  rows: RowAxis,
  name: string,
  chunks: readonly Pick<RowsBlock, 'rows' | 'columns'>[],
  positions: Map<number, number[]>,
  partial: boolean,
  memory: Memory,
  required?: RowAxis,
): { column: import('@latkit/model').TextColumn; presence?: Uint8Array } {
  const count = rowCount(rows),
    cells = new Map<number, { column: import('@latkit/model').TextColumn; at: number }>();
  return memory.stage(count * 24 + 4, () => {
    let length = 0;
    for (const chunk of chunks) {
      const column = chunk.columns[name];
      if (column.kind !== 'text')
        throw new GpuError('conflict', 'Field type changed across blocks');
      for (let i = 0; i < rowCount(chunk.rows); i++)
        for (const target of positions.get(rowAt(chunk.rows, i)) ?? []) {
          if (cells.has(target))
            throw new GpuError('invalid-input', 'Query returned a physical row twice');
          const at = column.offset + i;
          cells.set(target, { column, at });
          if (bit(column.validity, at)) length += column.offsets[at + 1] - column.offsets[at];
        }
    }
    return memory.stage(length + count / 4 + 2, () => {
      const bytes = new Uint8Array(length),
        offsets = new Int32Array(count + 1),
        validity = new Uint8Array(Math.ceil(count / 8)),
        presence = new Uint8Array(Math.ceil(count / 8));
      const requiredSet = required?.kind === 'indices' ? new Set(required.values) : undefined;
      let at = 0,
        nullable = false,
        complete = true;
      for (let i = 0; i < count; i++) {
        const cell = cells.get(i),
          row = rowAt(rows, i);
        if (!cell) {
          complete = false;
          if (
            !partial ||
            requiredSet?.has(row) ||
            (required?.kind === 'range' &&
              row >= required.offset &&
              row < required.offset + required.count)
          )
            throw new GpuError('invalid-input', 'Query did not cover the requested draw rows');
        } else {
          mark(presence, i);
          if (!bit(cell.column.validity, cell.at)) nullable = true;
          else {
            mark(validity, i);
            const data = cell.column.bytes.subarray(
              cell.column.offsets[cell.at],
              cell.column.offsets[cell.at + 1],
            );
            bytes.set(data, at);
            at += data.length;
          }
        }
        offsets[i + 1] = at;
      }
      return {
        column: {
          kind: 'text',
          offset: 0,
          length: count,
          bytes,
          offsets,
          validity: nullable ? validity : undefined,
        },
        presence: complete ? undefined : presence,
      };
    });
  });
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
        throw new GpuError('conflict', 'Sample coordinates differ across bindings');
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
        covered = new Uint32Array(rows);
      for (const chunk of chunks) {
        const column = chunk.columns[name];
        if (!column) throw new GpuError('invalid-input', 'Sample query omitted a field');
        for (let f = 0; f < chunk.coordinates.length; f++) {
          const targetFrame = chunk.firstFrame + f - anchor.firstFrame;
          if (
            targetFrame < 0 ||
            targetFrame >= frames ||
            chunk.coordinates[f] !== anchor.coordinates[targetFrame]
          )
            throw new GpuError('conflict', 'Sample coordinates differ across bindings');
          for (let r = 0; r < rowCount(chunk.rows); r++) {
            const targetRow = positions.get(rowAt(chunk.rows, r));
            if (targetRow === undefined) continue;
            const to = targetFrame * rows + targetRow,
              from = column.offset + f * column.frameStride + r * column.rowStride;
            if (bit(seen, to)) throw new GpuError('invalid-input', 'Overlapping sample tiles');
            mark(seen, to);
            covered[targetRow]++;
            if (bit(column.validity, from)) {
              mark(validity, to);
              values[to] = column.values[from];
            }
          }
        }
      }
      const mask = new Uint8Array(Math.ceil(rows / 8));
      let complete = true;
      const requiredSet = required?.kind === 'indices' ? new Set(required.values) : undefined;
      for (let r = 0; r < rows; r++) {
        if (covered[r] === frames) mark(mask, r);
        else if (
          covered[r] ||
          !partial ||
          requiredSet?.has(rowAt(anchor.rows, r)) ||
          (required?.kind === 'range' &&
            rowAt(anchor.rows, r) >= required.offset &&
            rowAt(anchor.rows, r) < required.offset + required.count)
        )
          throw new GpuError('invalid-input', 'Sample query did not cover its requested rectangle');
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

const nativeExtents = new WeakMap<
  object,
  { key: string; value: import('@latkit/model').Domain | null }
>();
function nativeExtent(tile: NativeFields, name: string): import('@latkit/model').Domain | null {
  const column = tile.columns[name];
  if (column.kind !== 'numeric')
    throw new GpuError('invalid-input', 'Scales require scalar numeric fields');
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
  const cache = nativeExtents.get(column);
  if (!mask && cache?.key === key) return cache.value;
  let lo = Infinity,
    hi = -Infinity;
  for (let row = 0; row < rows; row++) {
    if (!bit(mask, row)) continue;
    for (let frame = 0; frame < frames; frame++) {
      const at =
          column.offset + row * (sampled.rowStride ?? 1) + frame * (sampled.frameStride ?? 0),
        value = column.values[at];
      if (bit(column.validity, at) && Number.isFinite(value)) {
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    }
  }
  const result: import('@latkit/model').Domain | null = lo <= hi ? [lo, hi] : null;
  if (!mask) nativeExtents.set(column, { key, value: result });
  return result;
}
