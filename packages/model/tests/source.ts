import type {
  AggregateBlock,
  AggregateQuery,
  EndpointsBlock,
  EndpointsQuery,
  Filter,
  Index,
  LinksBlock,
  LinksQuery,
  NumericColumn,
  Query,
  Queryable,
  RetainOptions,
  RequestOptions,
  QueryBlock,
  QueryHeader,
  QueryOptions,
  RowAxis,
  RowSelection,
  RowsBlock,
  RowsQuery,
  SampleColumn,
  SamplesBlock,
  SamplesQuery,
  EnvelopeQuery,
  EnvelopeBlock,
  Schema,
  Update,
  Failure,
  SampleWindow,
} from '../src/index.js';
import { blockBuffers, blockByteLength, validateQuery } from '../src/index.js';
import { text } from './data.js';
import { RetainedBudget, retainOptions } from './retention.js';

export function failure(code: Failure['code'], message: string = code): Failure {
  return Object.assign(new Error(message), { code });
}
export interface Inputs {
  version: string;
  index: Index;
  ids: readonly string[];
  values: Float64Array;
}
export interface Frame {
  coordinate: number;
  values: Readonly<Record<string, Float64Array>>;
}
export interface FrameRead<F> {
  readonly grant?: FrameRead<{ readonly coordinate: number }>;
  readonly frames?: readonly F[];
  readonly firstFrame?: number;
  readonly frameCount?: number;
  readonly firstCoordinate?: number;
}
export interface ReadState extends FrameRead<Frame> {
  backing?: ReadonlyMap<object, number>;
  inputs: Inputs;
  version: string;
  schema: Schema;
  coverage?: ReadonlyMap<string, RowAxis>;
}
export const axisLength = (rows: RowAxis): number =>
  rows.kind === 'range' ? rows.count : rows.values.length;
export const axisAt = (rows: RowAxis, i: number): number =>
  rows.kind === 'range' ? rows.offset + i : rows.values[i];
export function axisValues(rows: RowAxis): number[] {
  return Array.from({ length: axisLength(rows) }, (_, i) => axisAt(rows, i));
}
export function compactRows(rows: readonly number[]): RowAxis {
  if (!rows.length || rows.every((value, i) => value === rows[0] + i))
    return { kind: 'range', offset: rows[0] ?? 0, count: rows.length };
  return { kind: 'indices', values: Uint32Array.from(rows) };
}
export function sliceRows(rows: RowAxis, start: number, end: number): RowAxis {
  return rows.kind === 'range'
    ? { kind: 'range', offset: rows.offset + start, count: end - start }
    : { kind: 'indices', values: rows.values.subarray(start, end) };
}
export function selectRows(inputs: Inputs, selection?: RowSelection): RowAxis {
  if (!selection) return { kind: 'range', offset: 0, count: inputs.ids.length };
  if (selection.kind === 'ids')
    return compactRows(
      selection.ids.map((id) => {
        const row = inputs.ids.indexOf(id);
        if (row < 0) throw failure('invalid-input');
        return row;
      }),
    );
  if (
    selection.index &&
    Object.entries(selection.index).some(
      ([key, value]) => inputs.index[key as keyof Index] !== value,
    )
  )
    throw failure('conflict');
  if (selection.kind === 'range') {
    if (selection.offset + selection.count > inputs.ids.length) throw failure('invalid-input');
    return { kind: 'range', offset: selection.offset, count: selection.count };
  }
  if (selection.values.some((row) => row >= inputs.ids.length)) throw failure('invalid-input');
  return { kind: 'indices', values: selection.values };
}
export function coveredRows(
  state: ReadState,
  fields: readonly string[],
  selection?: RowSelection,
): RowAxis {
  const coverage = fields.map((field) => {
    const rows = state.coverage?.get(field);
    if (!rows) throw failure('invalid-input');
    return rows;
  });
  const contains = (rows: RowAxis, row: number): boolean =>
    rows.kind === 'range'
      ? row >= rows.offset && row < rows.offset + rows.count
      : rows.values.includes(row);
  if (selection) {
    const rows = selectRows(state.inputs, selection);
    for (let i = 0; i < axisLength(rows); i++)
      if (coverage.some((available) => !contains(available, axisAt(rows, i))))
        throw failure('invalid-input');
    return rows;
  }
  const first = coverage[0];
  if (coverage.every((rows) => rows.kind === 'range')) {
    const ranges = coverage as Extract<RowAxis, { kind: 'range' }>[];
    const start = Math.max(...ranges.map((rows) => rows.offset));
    const end = Math.min(...ranges.map((rows) => rows.offset + rows.count));
    return { kind: 'range', offset: start, count: Math.max(0, end - start) };
  }
  return compactRows(
    axisValues(first)
      .filter((row) => coverage.every((rows) => contains(rows, row)))
      .sort((a, b) => a - b),
  );
}
export function selectFrames<F extends { readonly coordinate: number }>(
  state: FrameRead<F>,
  window: SampleWindow,
): { frames: readonly F[]; offset: number } {
  if (state.grant) {
    const selected = selectFrames(state.grant, window);
    const first = state.firstFrame ?? 0,
      end = state.frameCount ?? 0;
    if (selected.offset < first || selected.offset + selected.frames.length > end)
      throw failure('invalid-input', 'Query exceeds retained coverage.');
    return {
      frames: (state.frames ?? []).slice(
        selected.offset - first,
        selected.offset - first + selected.frames.length,
      ),
      offset: selected.offset,
    };
  }
  const frames = state.frames ?? [];
  const first = state.firstFrame ?? 0;
  if (window.kind === 'frames') {
    if (window.offset + window.count > (state.frameCount ?? 0)) throw failure('invalid-input');
    return {
      frames: frames.slice(window.offset - first, window.offset + window.count - first),
      offset: window.offset,
    };
  }
  if (window.kind === 'at') {
    if (state.firstCoordinate !== undefined && window.value < state.firstCoordinate)
      return { frames: [], offset: first };
    const i = coordinateBound(frames, window.value, true) - 1;
    return { frames: i < 0 ? [] : [frames[i]], offset: i < 0 ? first : first + i };
  }
  let start = coordinateBound(frames, window.between[0], false);
  let end = coordinateBound(frames, window.between[1], true);
  start -= Math.min(start, window.context?.before ?? 0);
  end += Math.min(frames.length - end, window.context?.after ?? 0);
  return { frames: frames.slice(start, end), offset: first + start };
}

/** Preserve only the immutable coordinate index outside a narrowed grant, never excluded payloads. */
export function retainFrames<F extends { readonly coordinate: number }, S extends FrameRead<F>>(
  state: S,
  options: RetainOptions,
): S {
  retainOptions(options);
  if (!state.frames) {
    if (options.window) throw failure('invalid-input', 'Input sources have no observation window.');
    return state;
  }
  const selected = options.window
    ? selectFrames(state, options.window)
    : { frames: state.frames, offset: state.firstFrame ?? 0 };
  const grant = state.grant ?? {
    frames: state.frames.map((f) => ({ coordinate: f.coordinate })),
    firstFrame: state.firstFrame,
    frameCount: state.frameCount,
    firstCoordinate: state.firstCoordinate,
  };
  return {
    ...state,
    frames: selected.frames,
    firstFrame: selected.offset,
    frameCount: selected.offset + selected.frames.length,
    grant,
  };
}

/** Binary searches the pinned coordinate index; numeric payloads are never inspected/copied. */
function coordinateBound(
  frames: readonly { readonly coordinate: number }[],
  coordinate: number,
  upper: boolean,
): number {
  let start = 0;
  let end = frames.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    const value = frames[middle].coordinate;
    if (value < coordinate || (upper && value === coordinate)) start = middle + 1;
    else end = middle;
  }
  return start;
}

export abstract class Source implements Queryable {
  abstract readonly version: string;
  abstract stateForRead(): ReadState;
  private sourceClosed = false;
  constructor(readonly retention = new RetainedBudget()) {}
  pulls = 0;
  released = 0;
  copiedBytes = 0;
  /** Test gate simulating a genuinely pending backend read. */
  readGate?: Promise<void>;
  private listeners = new Set<(change: Update) => void>();
  private reads = new Map<AbortController, () => Promise<unknown>>();
  async describe(options?: RequestOptions): Promise<Schema> {
    if (this.sourceClosed) throw failure('closed');
    if (options?.signal?.aborted) throw failure('aborted');
    return this.stateForRead().schema;
  }
  async retain(options: RetainOptions = {}): Promise<Queryable> {
    if (this.sourceClosed) throw failure('closed');
    const state = retainFrames(this.stateForRead(), options);
    const backing = new Map<object, number>([
      [state.inputs.values.buffer, state.inputs.values.buffer.byteLength],
      [state.inputs.ids, state.inputs.ids.reduce((n, id) => n + id.length * 2, 0)],
    ]);
    for (const frame of state.frames ?? []) {
      backing.set(frame, 8);
      for (const values of Object.values(frame.values))
        backing.set(values.buffer, values.buffer.byteLength);
    }
    for (const axis of state.coverage?.values() ?? [])
      if (axis.kind === 'indices') backing.set(axis.values.buffer, axis.values.buffer.byteLength);
    if (state.grant?.frames) backing.set(state.grant.frames, state.grant.frames.length * 8);
    for (const [key, bytes] of state.backing ?? []) backing.set(key, bytes);
    const release = this.retention.acquire(backing, options.maxBytes);
    return new RetainedSource(state, this.retention, release, this.executor);
  }
  async close(): Promise<void> {
    if (this.sourceClosed) return;
    this.sourceClosed = true;
    this.cancelReads();
    this.publish({ kind: 'closed' });
    this.listeners.clear();
  }
  on(_event: 'change', listener: (change: Update) => void): () => void {
    if (this.sourceClosed) throw failure('closed');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  publish(change: Update): void {
    for (const listener of this.listeners) listener(change);
  }
  cancelReads(): void {
    for (const [read, stop] of this.reads) {
      read.abort();
      void stop().catch(() => undefined);
    }
  }
  query(query: RowsQuery, options?: QueryOptions): AsyncIterable<QueryHeader | RowsBlock>;
  query(query: SamplesQuery, options?: QueryOptions): AsyncIterable<QueryHeader | SamplesBlock>;
  query(query: EnvelopeQuery, options?: QueryOptions): AsyncIterable<QueryHeader | EnvelopeBlock>;
  query(query: EndpointsQuery, options?: QueryOptions): AsyncIterable<QueryHeader | EndpointsBlock>;
  query(query: LinksQuery, options?: QueryOptions): AsyncIterable<QueryHeader | LinksBlock>;
  query(query: AggregateQuery, options?: QueryOptions): AsyncIterable<QueryHeader | AggregateBlock>;
  query(query: Query, options?: QueryOptions): AsyncIterable<QueryHeader | QueryBlock>;
  query(query: Query, options: QueryOptions = {}): AsyncIterable<QueryHeader | QueryBlock> {
    return {
      [Symbol.asyncIterator]: () => {
        const controller = new AbortController();
        const iterator = this.read(query, options, controller, () => iterator.return(undefined));
        return {
          next: async () => {
            if (options.signal?.aborted) throw failure('aborted');
            return iterator.next();
          },
          return: () => {
            controller.abort();
            return iterator.return(undefined);
          },
          throw: async (error: unknown) => {
            controller.abort();
            await iterator.return(undefined);
            throw error;
          },
        };
      },
    };
  }
  private async *read(
    query: Query,
    options: QueryOptions,
    controller: AbortController,
    stop: () => Promise<unknown>,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    if (this.sourceClosed) throw failure('closed');
    if (options.signal?.aborted) throw failure('aborted');
    // No await between pinning schema, inputs, frame coverage, and version.
    const state = this.stateForRead();
    const issues = validateQuery(state.schema, query);
    if (issues.length)
      throw Object.assign(
        failure(issues[0].code === 'unsupported' ? 'unsupported' : 'invalid-input'),
        { issues },
      );
    const abort = (): void => {
      controller.abort();
      void stop().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    this.reads.set(controller, stop);
    const blocks = this.blocks(query, state, options);
    try {
      yield { kind: 'schema', schema: state.schema, version: state.version };
      // Pull a block only after the backend gate/cancellation check, never eagerly prefetch.
      while (true) {
        if (controller.signal.aborted) throw failure('aborted');
        if (this.readGate) await interruptible(this.readGate, controller.signal);
        const next = blocks.next();
        if (next.done) break;
        this.pulls++;
        yield this.deliver(next.value, state.schema, options);
      }
    } finally {
      blocks.return(undefined);
      options.signal?.removeEventListener('abort', abort);
      this.reads.delete(controller);
      this.released++;
    }
  }
  protected get executor(): (
    query: Query,
    state: ReadState,
    options: QueryOptions,
  ) => Generator<QueryBlock> {
    return this.blocks;
  }
  protected *blocks(query: Query, state: ReadState, options: QueryOptions): Generator<QueryBlock> {
    if (query.kind === 'rows') yield* this.rows(query, state, options);
    else if (query.kind === 'samples') yield* this.samples(query, state, options);
    else if (query.kind === 'aggregate') yield* this.aggregate(query, state);
    else throw failure('unsupported');
  }
  protected numeric(values: Float64Array, rows: RowAxis): NumericColumn {
    const selected =
      rows.kind === 'range'
        ? values.subarray(rows.offset, rows.offset + rows.count)
        : Float64Array.from(rows.values, (row) => values[row]);
    if (rows.kind === 'indices') this.copiedBytes += selected.byteLength;
    return { kind: 'numeric', values: selected, offset: 0, length: axisLength(rows) };
  }
  protected *rows(query: RowsQuery, state: ReadState, options: QueryOptions): Generator<RowsBlock> {
    const fields = [
      ...new Set([
        ...query.select,
        ...(query.where ?? []).map((f) => f.field),
        ...(query.orderBy ?? []).map((o) => o.field),
      ]),
    ];
    const sampled = fields.filter((field) => state.schema.components.Node.fields[field]?.sampled);
    const frames = sampled.length
      ? selectFrames(state, { kind: 'at', value: query.at! }).frames
      : [];
    const frame = frames[0];
    let rows = sampled.length
      ? coveredRows(state, sampled, query.rows)
      : selectRows(state.inputs, query.rows);
    if (sampled.length && !frame) rows = { kind: 'range', offset: 0, count: 0 };
    const values = (field: string): Float64Array =>
      field === 'value' ? state.inputs.values : (frame?.values[field] ?? new Float64Array());
    if (query.where?.length || query.orderBy?.length) {
      let selected = axisValues(rows);
      if (query.where)
        selected = selected.filter((row) =>
          query.where!.every((filter) => matches(values(filter.field)[row], filter)),
        );
      if (query.orderBy?.length)
        selected.sort((a, b) => {
          for (const order of query.orderBy!) {
            const left = values(order.field)[a];
            const right = values(order.field)[b];
            const comparison = left < right ? -1 : left > right ? 1 : 0;
            if (comparison) return order.direction === 'ascending' ? comparison : -comparison;
          }
          return a - b;
        });
      rows = compactRows(selected);
    }
    const total = axisLength(rows);
    const start = Math.min(total, query.offset ?? 0);
    rows = sliceRows(rows, start, Math.min(total, start + (query.limit ?? total)));
    let position = 0;
    while (position < axisLength(rows) || (position === 0 && query.count && !axisLength(rows))) {
      let count = Math.min(2, axisLength(rows) - position);
      let block: RowsBlock;
      while (true) {
        const part = sliceRows(rows, position, position + count);
        const columns = Object.fromEntries(
          query.select.map((field) => [field, this.numeric(values(field), part)]),
        );
        block = {
          kind: 'rows',
          version: state.version,
          index: state.inputs.index,
          rows: part,
          position,
          columns,
          ...(query.count ? { total } : {}),
          ...(query.ids ? { ids: text(axisValues(part).map((row) => state.inputs.ids[row])) } : {}),
        };
        if (
          blockByteLength(block) <=
            Math.min(state.schema.limits.maxBlockBytes, options.maxBlockBytes ?? Infinity) ||
          count <= 1
        )
          break;
        count = Math.ceil(count / 2);
      }
      yield block;
      if (!count) break;
      position += count;
    }
  }
  protected *samples(
    query: SamplesQuery,
    state: ReadState,
    options: QueryOptions,
  ): Generator<SamplesBlock> {
    const { frames, offset } = selectFrames(state, query.window);
    const selected = coveredRows(state, query.select, query.rows);
    for (let frame = 0; frame < frames.length; frame++)
      for (let row = 0; row < axisLength(selected);) {
        let count = Math.min(2, axisLength(selected) - row);
        let block: SamplesBlock;
        while (true) {
          const rows = sliceRows(selected, row, row + count);
          const columns: Record<string, SampleColumn> = {};
          for (const field of query.select)
            columns[field] = {
              ...this.numeric(frames[frame].values[field], rows),
              frameStride: count,
              rowStride: 1,
            };
          block = {
            kind: 'samples',
            version: state.version,
            index: state.inputs.index,
            rows,
            rowOffset: row,
            firstFrame: offset + frame,
            coordinates: new Float64Array([frames[frame].coordinate]),
            columns,
          };
          if (
            blockByteLength(block) <=
              Math.min(state.schema.limits.maxBlockBytes, options.maxBlockBytes ?? Infinity) ||
            count <= 1
          )
            break;
          count = Math.ceil(count / 2);
        }
        yield block;
        row += count;
      }
  }
  protected *aggregate(query: AggregateQuery, state: ReadState): Generator<AggregateBlock> {
    const rows = query.window
      ? coveredRows(state, query.select, query.rows)
      : selectRows(state.inputs, query.rows);
    const frames = query.window ? selectFrames(state, query.window).frames : undefined;
    for (const field of query.select) {
      let count = 0;
      let min = Infinity;
      let max = -Infinity;
      const arrays = frames ? frames.map((frame) => frame.values[field]) : [state.inputs.values];
      for (const values of arrays)
        for (let i = 0; i < axisLength(rows); i++) {
          const value = values[axisAt(rows, i)];
          if (Number.isFinite(value)) {
            count++;
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
        }
      yield {
        kind: 'aggregate',
        version: state.version,
        values: {
          [field]: {
            count,
            ...(query.measures.includes('min') ? { min: count ? min : null } : {}),
            ...(query.measures.includes('max') ? { max: count ? max : null } : {}),
          },
        },
      };
    }
  }
  protected deliver<T extends QueryBlock>(block: T, schema: Schema, options: QueryOptions): T {
    const bound = Math.min(schema.limits.maxBlockBytes, options.maxBlockBytes ?? Infinity);
    if (blockByteLength(block) > bound) throw failure('resource-limit');
    if (options.buffers !== 'owned') return block;
    // Copy exposed views, never an entire oversized parent allocation. Production implementations
    // may relinquish already-exclusive buffers instead; this fixture measures its actual copies.
    const clone = (value: unknown): unknown => {
      if (
        value instanceof Float64Array ||
        value instanceof Float32Array ||
        value instanceof Int32Array ||
        value instanceof Uint32Array ||
        value instanceof Uint8Array
      ) {
        this.copiedBytes += value.byteLength;
        return value.slice();
      }
      if (Array.isArray(value)) return value.map(clone);
      if (typeof value === 'object' && value !== null)
        return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, clone(value)]));
      return value;
    };
    const result = clone(block) as T;
    if (blockBuffers(result).reduce((n, buffer) => n + buffer.byteLength, 0) > bound)
      throw failure('resource-limit');
    return result;
  }
}
function matches(value: number, filter: Filter): boolean {
  switch (filter.operator) {
    case 'equal':
      return value === filter.value;
    case 'notEqual':
      return value !== filter.value;
    case 'lessThan':
      return value < filter.value;
    case 'lessThanOrEqual':
      return value <= filter.value;
    case 'greaterThan':
      return value > filter.value;
    case 'greaterThanOrEqual':
      return value >= filter.value;
    case 'contains':
      return false; // No text field is advertised by this numeric fixture.
  }
}
async function interruptible(task: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw failure('aborted');
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(failure('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void task.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : failure('internal'));
      },
    );
  });
}

class RetainedSource extends Source {
  readonly version: string;
  constructor(
    private state: ReadState | undefined,
    override readonly retention: RetainedBudget,
    private readonly release: () => void,
    private readonly execute: (
      query: Query,
      state: ReadState,
      options: QueryOptions,
    ) => Generator<QueryBlock>,
  ) {
    super();
    this.version = state!.version;
  }
  protected override get executor() {
    return this.execute;
  }
  protected override *blocks(
    query: Query,
    state: ReadState,
    options: QueryOptions,
  ): Generator<QueryBlock> {
    yield* this.execute.call(this, query, state, options);
  }
  stateForRead(): ReadState {
    if (!this.state) throw failure('closed');
    return this.state;
  }
  override async close(): Promise<void> {
    await super.close();
    this.state = undefined;
    this.release();
  }
}
