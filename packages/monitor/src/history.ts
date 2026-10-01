import { GpuError, type Gpu, type NativeFields, type FieldInput } from '@latkit/gpu';
import {
  assertIndex,
  bitAt,
  rowAt,
  rowCount,
  sliceRows,
  type Domain,
  type EnvelopeBlock,
  type Index,
  type RowAxis,
  type SampleRange,
  type SampleWindow,
  type Queryable,
} from '@latkit/model';
import type { Binding } from './bindings.js';
import type { MonitorData } from './data.js';
import type { Limits } from './options.js';
import { yieldWork } from './async.js';
export interface Chunk {
  readonly binding: Binding;
  readonly data: EnvelopeBlock | NativeFields;
  /** Four normalized renderer style values per native row: color scalar, visibility, shade, spare. */
  readonly styles?: Float64Array;
}
export function isEnvelope(data: Chunk['data']): data is EnvelopeBlock {
  return 'kind' in data;
}
export interface HistoryRequest {
  readonly gpu: Gpu;
  readonly data: MonitorData;
  readonly bindings: readonly Binding[];
  readonly window: SampleRange;
  readonly pixels: number;
  readonly detail: 'auto' | 'full';
  readonly limits: Required<Limits>;
  readonly signal: AbortSignal;
  readonly onRows?: (count: number) => void;
  readonly frames?: { offset: number; count: number };
  readonly focus?: { source: Queryable; index: Index; row: number; field?: string };
}
export async function* history(request: HistoryRequest): AsyncGenerator<Chunk> {
  const { gpu, data, bindings, window, detail, limits, signal, frames, focus } = request;
  let admitted = 0,
    yieldedAt = performance.now();
  for (const item of bindings) {
    const pixels = Math.max(
      1,
      Math.min(
        request.pixels,
        Math.floor(
          (Math.min(
            item.schema.limits.maxBlockBytes,
            gpu.budget.stagingBytes / 2,
            gpu.budget.cpuBytes / 4,
          ) -
            4096) /
            100,
        ),
      ),
    );
    if (
      focus &&
      (item.source !== focus.source ||
        item.trace.from !== focus.index.type ||
        (focus.field && item.field !== focus.field))
    )
      continue;
    const rows = focus
      ? { kind: 'range' as const, index: focus.index, offset: focus.row, count: 1 }
      : item.rows;
    let first: number | undefined;
    if (!frames)
      for await (const part of gpu.query(
        item.source,
        {
          kind: 'samples',
          from: item.trace.from,
          rows,
          select: [item.field],
          window: { kind: 'at', value: window.between[0] },
        },
        { signal },
      )) {
        if (part.kind !== 'schema') {
          first = part.firstFrame;
          break;
        }
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
    for await (const block of gpu.query(item.source, discovery, { signal })) {
      if (block.kind === 'schema') continue;
      discovered = true;
      if (focus) assertIndex(focus.index, block.index);
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
                (Math.min(
                  gpu.budget.stagingBytes / 4,
                  item.schema.limits.maxBlockBytes,
                  512 * 1024,
                ) -
                  2048) /
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
          for await (const envelope of gpu.envelope(
            {
              source: item.source,
              query: {
                kind: 'envelope',
                from: item.trace.from,
                rows: selection,
                select: [item.field],
                window: range as SampleRange,
                buckets:
                  window.between[0] === window.between[1] ? 1 : Math.max(1, Math.floor(pixels)),
              },
            },
            { signal },
          )) {
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
                gpu,
                data,
                item,
                { ...envelope.rows, index: envelope.index },
                local,
                signal,
                envelope.firstBucket + envelope.bucketCount < count ? local.between[1] : undefined,
              );
            } else {
              const styles = await rowStyles(
                gpu,
                data,
                item,
                envelope.rows,
                envelope.index,
                signal,
              );
              yield { binding: item, data: envelope, styles };
            }
          }
        } else yield* raw(gpu, data, item, selection, range, signal);
        if (performance.now() - yieldedAt >= 3) {
          await yieldWork(signal);
          yieldedAt = performance.now();
        }
      }
    }
    // Before the first coordinate, explicit context may still request an observation.
    if (!discovered && window.context?.after) yield* raw(gpu, data, item, rows, window, signal);
  }
}
async function* raw(
  gpu: Gpu,
  data: MonitorData,
  item: Binding,
  rows: import('@latkit/model').RowSelection | undefined,
  window: SampleWindow,
  signal: AbortSignal,
  exclusiveEnd?: number,
): AsyncGenerator<Chunk> {
  for await (const native of gpu.fields(
    { source: data.source, from: item.trace.from, rows, fields: item.fields, window },
    { signal },
  )) {
    if (exclusiveEnd === undefined) {
      yield { binding: item, data: native };
      continue;
    }
    const coordinates = native.samples!.coordinates;
    let count = coordinates.length;
    while (count && coordinates[count - 1] >= exclusiveEnd) count--;
    if (!count) continue;
    const columns: Record<string, import('@latkit/model').Column> = {};
    for (const [name, column] of Object.entries(native.columns))
      columns[name] =
        'frameStride' in column
          ? {
              ...column,
              length:
                (rowCount(native.rows) - 1) *
                  (column as import('@latkit/model').SampleColumn).rowStride +
                (count - 1) * (column as import('@latkit/model').SampleColumn).frameStride +
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
  gpu: Gpu,
  data: MonitorData,
  item: Binding,
  rows: RowAxis,
  index: Index,
  signal: AbortSignal,
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
  for await (const tile of gpu.fields(
    { source: data.source, from: item.trace.from, rows: { ...rows, index }, fields: selected },
    { signal },
  )) {
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
