import {
  assertIndex,
  bitAt,
  blockBuffers,
  blockByteLength,
  rowAt,
  rowCount,
  sliceRows,
  validateQuery,
  type EnvelopeBlock,
  type EnvelopeColumn,
  type EnvelopeQuery,
  type NumericArray,
  type Queryable,
  type Schema,
  type SamplesBlock,
} from '@latkit/model';
import { GpuError, integer, interruptible } from './error.js';
import type { Entry, Memory } from './memory.js';
import type { Preparation } from './render.js';

export interface EnvelopeRequest {
  readonly source: Queryable;
  readonly query: EnvelopeQuery;
}
type Frame = Pick<Preparation, 'query' | 'signal'>;

/** The raw fallback has bounded row/bucket working storage; raw history is always pulled. */
export class Envelopes {
  private cache = new WeakMap<Queryable, Map<string, { block: EnvelopeBlock; entry: Entry }>>();
  constructor(
    private readonly memory: Memory,
    private readonly maxBlockBytes: number,
  ) {}

  async *prepare({ source, query }: EnvelopeRequest, frame: Frame): AsyncGenerator<EnvelopeBlock> {
    const schema = await interruptible(source.describe({ signal: frame.signal }), frame.signal);
    const problems = validateQuery({ ...schema, queries: [...schema.queries, 'envelope'] }, query);
    if (problems.length) throw new GpuError('invalid-input', problems[0].message);
    if (schema.queries.includes('envelope')) {
      for await (const block of frame.query(source, query))
        if (block.kind !== 'schema') yield block;
      return;
    }
    if (!schema.queries.includes('samples'))
      throw new GpuError('unsupported', 'Envelopes require native summaries or sampled reads');
    const bound = Math.min(
      this.maxBlockBytes,
      schema.limits.maxBlockBytes,
      this.memory.budget.stagingBytes / 2,
    );
    const fields =
      schema.components[query.from]?.fields ??
      schema.connections[query.from]?.fields ??
      schema.tables?.[query.from]?.fields;
    const rowBytes =
      query.buckets *
      query.select.reduce(
        (n, field) => n + 4 * (fields![field].type === 'float64' ? 24 : 20) + 1,
        0,
      );
    const tileRows = Math.floor((bound - 2048 - query.select.join('').length * 4) / rowBytes);
    if (tileRows < 1)
      throw new GpuError('resource-limit', 'Envelope bucket count exceeds the native block budget');
    // The sampled discovery reads only one observation. Omitted rows retain captured intersection semantics.
    const initial = frame.query(source, {
      kind: 'samples',
      from: query.from,
      ...(query.rows ? { rows: query.rows } : {}),
      select: query.select,
      window: { kind: 'at', value: query.window.between[1] },
    });
    const discovery = (async function* () {
      let seen = false;
      for await (const block of initial) {
        if (block.kind !== 'schema') seen = true;
        yield block;
      }
      if (!seen && query.window.context?.after) {
        let selectedFrame: number | undefined;
        for await (const block of frame.query(source, {
          kind: 'samples',
          from: query.from,
          ...(query.rows ? { rows: query.rows } : {}),
          select: query.select,
          window: query.window,
        })) {
          if (block.kind === 'schema') {
            yield block;
            continue;
          }
          selectedFrame ??= block.firstFrame;
          if (
            selectedFrame >= block.firstFrame &&
            selectedFrame < block.firstFrame + block.coordinates.length
          )
            yield block;
        }
      }
    })();
    let cache = this.cache.get(source);
    if (!cache) {
      cache = new Map();
      this.cache.set(source, cache);
    }
    for await (const discovered of discovery) {
      if (discovered.kind === 'schema') {
        continue;
      }
      const discoveredOffset = discovered.rowOffset;
      for (let offset = 0; offset < rowCount(discovered.rows); offset += tileRows) {
        frame.signal.throwIfAborted();
        const rows = sliceRows(
          discovered.rows,
          offset,
          Math.min(tileRows, rowCount(discovered.rows) - offset),
        );
        const key = JSON.stringify([
          discovered.version,
          query.from,
          query.select,
          query.window,
          query.buckets,
          discoveredOffset + offset,
          rows.kind === 'range' ? rows : [...rows.values],
        ]);
        const hit = cache.get(key);
        if (hit?.entry.live) {
          hit.entry.pin();
          this.memory.queryHits++;
          try {
            yield hit.block;
          } finally {
            hit.entry.unpin();
          }
          continue;
        }
        const allocation = this.memory.stage(rowCount(rows) * rowBytes, () =>
          createColumns(schema, query, rowCount(rows)),
        );
        const block: EnvelopeBlock = {
          kind: 'envelope',
          version: discovered.version,
          index: discovered.index,
          rows,
          rowOffset: discoveredOffset + offset,
          firstBucket: 0,
          bucketCount: query.buckets,
          columns: allocation.columns,
        };
        const entry = this.memory.add(
          [...blockBuffers(block), ...Object.values(allocation.gaps).map((mask) => mask.buffer)],
          256 + key.length * 2,
          () => {
            if (cache!.get(key)?.entry === entry) cache!.delete(key);
          },
        );
        let complete = false;
        try {
          for await (const part of frame.query(source, {
            kind: 'samples',
            from: query.from,
            select: query.select,
            rows: { ...rows, index: discovered.index },
            window: query.window,
          })) {
            if (part.kind === 'schema') continue;
            assertIndex(discovered.index, part.index);
            await accumulate(block, allocation.gaps, part, query, frame.signal);
          }
          for (const [name, field] of Object.entries(block.columns)) {
            for (let cell = 0; cell < rowCount(rows) * query.buckets; cell++)
              if (bitAt(field.values.validity, cell * 4) && !bitAt(allocation.gaps[name], cell))
                mark(field.continuous, cell);
          }
          if (blockByteLength(block) > bound)
            throw new GpuError('resource-limit', 'Envelope tile exceeds its byte bound');
          frame.signal.throwIfAborted();
          cache.set(key, { block, entry });
          complete = true;
          yield block;
        } finally {
          if (complete) entry.unpin();
          else this.memory.remove(entry);
        }
      }
    }
  }
}
function createColumns(
  schema: Schema,
  query: EnvelopeQuery,
  rows: number,
): { columns: Record<string, EnvelopeColumn>; gaps: Record<string, Uint8Array> } {
  const fields =
    schema.components[query.from]?.fields ??
    schema.connections[query.from]?.fields ??
    schema.tables?.[query.from]?.fields;
  const cells = integer(rows * query.buckets, 'envelope cells', 1, 0x1fffffff),
    length = cells * 4;
  const columns: Record<string, EnvelopeColumn> = {},
    gaps: Record<string, Uint8Array> = {};
  for (const name of query.select) {
    const type = fields![name].type;
    const values: NumericArray =
      type === 'float64'
        ? new Float64Array(length)
        : type === 'int32'
          ? new Int32Array(length)
          : type === 'uint32'
            ? new Uint32Array(length)
            : new Float32Array(length);
    columns[name] = {
      values: {
        kind: 'numeric',
        values,
        offset: 0,
        length,
        validity: new Uint8Array(Math.ceil(length / 8)),
      },
      coordinates: new Float64Array(length),
      frames: new Float64Array(length),
      continuous: new Uint8Array(Math.ceil(cells / 8)),
    };
    gaps[name] = new Uint8Array(Math.ceil(cells / 8));
  }
  return { columns, gaps };
}
function mark(mask: Uint8Array, at: number): void {
  mask[at >>> 3] |= 1 << (at & 7);
}
async function accumulate(
  target: EnvelopeBlock,
  gaps: Readonly<Record<string, Uint8Array>>,
  block: SamplesBlock,
  query: EnvelopeQuery,
  signal: AbortSignal,
): Promise<void> {
  const axis = target.rows;
  let positions: Map<number, number> | undefined;
  if (axis.kind === 'indices') positions = new Map([...axis.values].map((row, i) => [row, i]));
  const [lo, hi] = query.window.between,
    span = hi - lo;
  let checked = performance.now(),
    work = 0;
  for (let frame = 0; frame < block.coordinates.length; frame++) {
    const coordinate = block.coordinates[frame],
      absolute = block.firstFrame + frame;
    const bucket =
      span === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              query.buckets - 1,
              Math.floor(
                (Number.isFinite(span)
                  ? (coordinate - lo) / span
                  : (coordinate / 2 - lo / 2) / (hi / 2 - lo / 2)) * query.buckets,
              ),
            ),
          );
    for (let row = 0; row < rowCount(block.rows); row++) {
      if ((++work & 4095) === 0 && performance.now() - checked >= 4) {
        signal.throwIfAborted();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
        checked = performance.now();
      }
      const physical = rowAt(block.rows, row),
        position = axis.kind === 'range' ? physical - axis.offset : positions!.get(physical);
      if (position === undefined || position < 0 || position >= rowCount(axis))
        throw new GpuError('invalid-input', 'Sample tile lies outside its envelope selection');
      const cell = position * query.buckets + bucket,
        start = cell * 4;
      for (const name of query.select) {
        const source = block.columns[name],
          out = target.columns[name];
        if (!source) throw new GpuError('invalid-input', 'Samples omitted an envelope field');
        const at = source.offset + row * source.rowStride + frame * source.frameStride,
          value = source.values[at];
        if (!bitAt(source.validity, at) || !Number.isFinite(value)) {
          mark(gaps[name], cell);
          continue;
        }
        const write = (slot: number) => {
          const i = start + slot;
          out.values.values[i] = value;
          out.coordinates[i] = coordinate;
          out.frames[i] = absolute;
          mark(out.values.validity!, i);
        };
        if (!bitAt(out.values.validity, start)) for (let slot = 0; slot < 4; slot++) write(slot);
        else {
          if (absolute < out.frames[start]) write(0);
          if (
            value < out.values.values[start + 1] ||
            (value === out.values.values[start + 1] && absolute < out.frames[start + 1])
          )
            write(1);
          if (
            value > out.values.values[start + 2] ||
            (value === out.values.values[start + 2] && absolute < out.frames[start + 2])
          )
            write(2);
          if (absolute > out.frames[start + 3]) write(3);
        }
      }
    }
  }
}
