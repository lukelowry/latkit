import type { FrameRanges, FrameRange } from './data.js';
import { GpuError, type Gpu } from '@latkit/gpu';
import {
  assertIndex,
  bitAt,
  rowAt,
  rowCount,
  sliceRows,
  type Column,
  type Domain,
  type EnvelopeBlock,
  type FieldInput,
  type FieldsBlock,
  type Index,
  type ReadScope,
  type RowAxis,
  type RowSelection,
  type SampleColumn,
  type SampleRange,
  type SampleWindow,
  type Data,
} from '@latkit/model';
import type { Binding } from './bindings.js';
import type { MonitorData } from './data.js';
import type { Limits } from './options.js';
import { yieldWork } from './async.js';
export interface Chunk {
  readonly binding: Binding;
  readonly data: EnvelopeBlock | FieldsBlock;
  /** Four normalized renderer style values per native row: color scalar, visibility, shade, spare. */
  readonly styles?: Float64Array;
}
export function isEnvelope(data: Chunk['data']): data is EnvelopeBlock {
  return data.kind === 'envelope';
}
export interface HistoryRequest {
  readonly gpu: Gpu;
  readonly reads: ReadScope;
  readonly data: MonitorData;
  readonly bindings: readonly Binding[];
  readonly window: SampleRange;
  readonly pixels: number;
  readonly detail: 'auto' | 'full';
  readonly limits: Required<Limits>;
  readonly onRows?: (count: number) => void;
  readonly frames?: FrameRanges;
  /** Draw only these rows, each narrowed to one field when it names one. */
  readonly focus?: readonly Focus[];
}
export interface Focus {
  readonly source: Data;
  readonly index: Index;
  readonly row: number;
  readonly field?: string;
}
/** The focused rows a binding draws, ascending; undefined when it draws none. */
function focused(focus: readonly Focus[], item: Binding): RowSelection | undefined {
  const matching = focus.filter(
    (f) =>
      f.source === item.source &&
      f.index.type === item.trace.from &&
      (!f.field || f.field === item.field),
  );
  if (!matching.length) return undefined;
  const index = matching[0].index;
  for (const f of matching) assertIndex(index, f.index);
  const rows = Uint32Array.from(new Set(matching.map((f) => f.row))).sort();
  return rows.length === 1
    ? { kind: 'range', index, offset: rows[0], count: 1 }
    : { kind: 'indices', index, values: rows };
}
export async function* history(request: HistoryRequest): AsyncGenerator<Chunk> {
  if (!request.frames) {
    yield* readHistory({ ...request, frames: undefined });
    return;
  }
  let admitted = 0;
  for (const item of request.bindings) {
    let rows = 0;
    for (const range of request.frames.get(item.name) ?? [])
      yield* readHistory({
        ...request,
        bindings: [item],
        frames: range,
        onRows: (count) => {
          rows = Math.max(rows, count);
          if (admitted + rows > request.limits.rows)
            throw new GpuError('resource-limit', 'Monitor row limit exceeded');
          request.onRows?.(admitted + rows);
        },
      });
    admitted += rows;
  }
}
async function* readHistory(
  request: Omit<HistoryRequest, 'frames'> & { readonly frames?: FrameRange },
): AsyncGenerator<Chunk> {
  const { gpu, reads, data, bindings, window, detail, limits, frames, focus } = request;
  const signal = reads.signal;
  let admitted = 0,
    yieldedAt = performance.now();
  for (const item of bindings) {
    const pixels = Math.max(
      1,
      Math.min(
        request.pixels,
        Math.floor((Math.min(gpu.budget.stagingBytes / 2, gpu.budget.cpuBytes / 4) - 4096) / 100),
      ),
    );
    const rows = focus ? focused(focus, item) : item.rows;
    if (focus && !rows) continue;
    let first: number | undefined;
    if (!frames)
      for await (const part of reads.read(item.source, {
        kind: 'samples',
        from: item.trace.from,
        rows,
        select: [item.field],
        window: { kind: 'at', value: window.between[0] },
      })) {
        first = part.firstFrame;
        break;
      }
    let discovered = false;
    const discovery = {
      kind: 'samples' as const,
      from: item.trace.from,
      rows,
      select: [item.field],
      window: frames
        ? { kind: 'frames' as const, offset: frames.offset, count: 1 }
        : { kind: 'at' as const, value: window.between[1] },
    };
    for await (const block of reads.read(item.source, discovery)) {
      discovered = true;
      if (rows && 'index' in rows && rows.index) assertIndex(rows.index, block.index);
      admitted += rowCount(block.rows);
      request.onRows?.(admitted);
      if (admitted > limits.rows)
        throw new GpuError('resource-limit', 'Monitor row limit exceeded');
      const reduced =
        !frames &&
        detail === 'auto' &&
        item.envelope &&
        (first === undefined || block.firstFrame - first > pixels * 2);
      const batchRows = reduced
        ? Math.max(
            1,
            Math.min(
              128,
              Math.floor(
                (Math.min(gpu.budget.stagingBytes / 4, 512 * 1024) - 2048) /
                  (Math.max(1, pixels) * 100),
              ),
            ),
          )
        : Math.min(1024, Math.max(1, limits.rows));
      for (let offset = 0; offset < rowCount(block.rows); offset += batchRows) {
        const selected = sliceRows(
          block.rows,
          offset,
          Math.min(batchRows, rowCount(block.rows) - offset),
        );
        const selection = { ...selected, index: block.index };
        const range: SampleWindow = frames
          ? { kind: 'frames', offset: frames.offset, count: frames.count }
          : {
              ...window,
              context: {
                before: Math.max(1, window.context?.before ?? 0),
                after: Math.max(1, window.context?.after ?? 0),
              },
            };
        if (reduced) {
          // One bounded native rectangle. Gapped rectangles refine with aligned samples.
          for await (const envelope of reads.read(item.source, {
            kind: 'envelope',
            from: item.trace.from,
            rows: selection,
            select: [item.field],
            window: range as SampleRange,
            buckets: window.between[0] === window.between[1] ? 1 : Math.max(1, Math.floor(pixels)),
          })) {
            const column = envelope.columns[item.field];
            let gap = false;
            for (let cell = 0; cell < rowCount(envelope.rows) * envelope.bucketCount; cell++)
              if (
                bitAt(column.values.validity, column.values.offset + cell * 4) &&
                !bitAt(column.continuous, cell)
              ) {
                gap = true;
                break;
              }
            if (gap) {
              const span = window.between[1] - window.between[0],
                count = Math.max(1, Math.floor(pixels));
              const local: SampleRange = {
                kind: 'range',
                between: [
                  window.between[0] + (span * envelope.firstBucket) / count,
                  window.between[0] +
                    (span * (envelope.firstBucket + envelope.bucketCount)) / count,
                ],
                context: {
                  before: envelope.firstBucket === 0 ? Math.max(1, window.context?.before ?? 0) : 0,
                  after:
                    envelope.firstBucket + envelope.bucketCount === count
                      ? Math.max(1, window.context?.after ?? 0)
                      : 0,
                },
              };
              yield* raw(
                reads,
                data,
                item,
                { ...envelope.rows, index: envelope.index },
                local,
                envelope.firstBucket + envelope.bucketCount < count ? local.between[1] : undefined,
              );
            } else {
              const styles = await rowStyles(reads, data, item, envelope.rows, envelope.index);
              yield { binding: item, data: envelope, styles };
            }
          }
        } else yield* raw(reads, data, item, selection, range);
        if (performance.now() - yieldedAt >= 3) {
          await yieldWork(signal);
          yieldedAt = performance.now();
        }
      }
    }
    // Before the first coordinate, explicit context may still request an observation.
    if (!discovered && window.context?.after) yield* raw(reads, data, item, rows, window);
  }
}
async function* raw(
  reads: ReadScope,
  data: MonitorData,
  item: Binding,
  rows: RowSelection | undefined,
  window: SampleWindow,
  exclusiveEnd?: number,
): AsyncGenerator<Chunk> {
  for await (const native of reads.fields({
    source: data.source,
    from: item.trace.from,
    rows,
    fields: item.fields,
    window,
  })) {
    if (exclusiveEnd === undefined) {
      yield { binding: item, data: native };
      continue;
    }
    const coordinates = native.samples!.coordinates;
    let count = coordinates.length;
    while (count && coordinates[count - 1] >= exclusiveEnd) count--;
    if (!count) continue;
    const columns: Record<string, Column> = {};
    for (const [name, column] of Object.entries(native.columns))
      columns[name] =
        'frameStride' in column
          ? {
              ...column,
              length:
                (rowCount(native.rows) - 1) * (column as SampleColumn).rowStride +
                (count - 1) * (column as SampleColumn).frameStride +
                1,
            }
          : column;
    yield {
      binding: item,
      data: {
        ...native,
        columns,
        samples: { ...native.samples!, coordinates: coordinates.subarray(0, count) },
      },
    };
  }
}
async function rowStyles(
  reads: ReadScope,
  data: MonitorData,
  item: Binding,
  rows: RowAxis,
  index: Index,
): Promise<Float64Array> {
  const output = new Float64Array(rowCount(rows) * 4);
  for (let i = 0; i < rowCount(rows); i++) {
    output[i * 4] = NaN;
    output[i * 4 + 1] = 1;
  }
  const selected: Record<string, FieldInput> = {};
  for (const name of ['color', 'visible', 'shade'] as const)
    if (
      item.fields[name] &&
      !(name === 'color' && item.colorValue) &&
      !(name === 'shade' && item.shadeValue)
    )
      selected[name] = item.fields[name];
  if (!Object.keys(selected).length) return output;
  const offsets = new Map<number, number>();
  for (let r = 0; r < rowCount(rows); r++) offsets.set(rowAt(rows, r), r);
  for await (const tile of reads.fields({
    source: data.source,
    from: item.trace.from,
    rows: { ...rows, index },
    fields: selected,
  })) {
    for (let r = 0; r < rowCount(tile.rows); r++) {
      const to = offsets.get(rowAt(tile.rows, r))!;
      for (const [name, column] of Object.entries(tile.columns)) {
        const at = column.offset + r;
        if (!bitAt(tile.presence[name], r)) continue;
        const valid = bitAt(column.validity, at);
        const value =
          column.kind === 'numeric'
            ? column.values[at]
            : column.kind === 'boolean'
              ? bitAt(column.values, at)
                ? 1
                : 0
              : NaN;
        output[to * 4 + ['color', 'visible', 'shade'].indexOf(name)] = valid
          ? value
          : name === 'visible'
            ? 0
            : NaN;
      }
    }
  }
  return output;
}
export function mergeDomain(a: Domain | null, b: Domain | null): Domain | null {
  return !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}
