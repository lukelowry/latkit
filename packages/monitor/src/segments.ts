import { GpuError, kit } from '@latkit/gpu';
import {
  bitAt,
  rowAt,
  rowCount,
  sliceRows,
  sampleAt,
  type Domain,
  type Column,
  type SampleColumn,
} from '@latkit/model';
import { isEnvelope, type Chunk } from './history.js';
export function buffer(values: ArrayBufferView, label: string): kit.BufferData {
  const data = new kit.BufferData({ size: Math.max(16, values.byteLength), label });
  if (values.byteLength) data.write({ data: values });
  return data;
}
function bitmap(mask: Uint8Array, offset: number, count: number): Uint8Array {
  if (offset % 8 === 0) return mask.subarray(offset / 8, Math.ceil((offset + count) / 8));
  const out = new Uint8Array(Math.ceil(count / 8));
  for (let i = 0; i < count; i++) if (bitAt(mask, offset + i)) out[i >>> 3] |= 1 << (i & 7);
  return out;
}
/** Only descriptors/slices change; observed numeric buffers keep their native backing. */
export function* split(chunk: Chunk, maximum: number): Generator<Chunk> {
  const input = chunk.data,
    nr = rowCount(input.rows);
  if (isEnvelope(input)) {
    const width = input.bucketCount,
      step = Math.max(1, Math.floor(maximum / 4));
    const rows = Math.max(1, Math.floor(step / width)),
      buckets = Math.min(width, step);
    for (let r = 0; r < nr; r += rows)
      for (let f = 0; f < width; f += buckets) {
        const count = Math.min(rows, nr - r),
          nf = Math.min(buckets, width - f),
          start = (r * width + f) * 4,
          length = count * nf * 4;
        const columns: Record<string, import('@latkit/model').EnvelopeColumn> = {};
        for (const [name, c] of Object.entries(input.columns))
          columns[name] = {
            values: { ...c.values, offset: c.values.offset + start, length },
            coordinates: c.coordinates.subarray(start, start + length),
            frames: c.frames.subarray(start, start + length),
            continuous: bitmap(c.continuous, r * width + f, count * nf),
          };
        yield {
          ...chunk,
          styles: chunk.styles?.subarray(r * 4, (r + count) * 4),
          data: {
            ...input,
            rows: sliceRows(input.rows, r, count),
            rowOffset: input.rowOffset + r,
            firstBucket: input.firstBucket + f,
            bucketCount: nf,
            columns,
          },
        };
      }
  } else {
    const width = input.samples!.coordinates.length,
      rows = Math.max(1, Math.floor(maximum / Math.max(1, width))),
      frames = Math.min(width, maximum);
    for (let r = 0; r < nr; r += rows)
      for (let f = 0; f < width; f += frames) {
        const count = Math.min(rows, nr - r),
          nf = Math.min(frames, width - f),
          columns: Record<string, Column> = {};
        for (const [name, c] of Object.entries(input.columns)) {
          if ('frameStride' in c) {
            const sampled = c as SampleColumn;
            columns[name] = {
              ...sampled,
              offset: c.offset + r * sampled.rowStride + f * sampled.frameStride,
              length: (count - 1) * sampled.rowStride + (nf - 1) * sampled.frameStride + 1,
            };
          } else columns[name] = { ...c, offset: c.offset + r, length: count };
        }
        const presence = Object.fromEntries(
          Object.entries(input.presence).map(([name, bits]) => [name, bitmap(bits, r, count)]),
        );
        yield {
          ...chunk,
          data: {
            ...input,
            rows: sliceRows(input.rows, r, count),
            rowOffset: input.rowOffset + r,
            columns,
            presence,
            samples: {
              firstFrame: input.samples!.firstFrame + f,
              coordinates: input.samples!.coordinates.subarray(f, f + nf),
            },
          },
        };
      }
  }
}
export interface Point {
  frame: number;
  coordinate: number;
  value: number;
  color: number;
  shade: number;
  visible: boolean;
}
export interface Geometry {
  readonly addresses: kit.BufferData;
  readonly joins: kit.BufferData;
  readonly count: number;
  readonly joinCount: number;
  readonly raw: boolean;
}
export class Seams {
  private starts = new Map<string, Point>();
  private ends = new Map<string, Point>();
  readonly tails = new Map<string, Point>();
  constructor(private readonly maxBytes: number) {}
  get bytes() {
    return (this.starts.size + this.ends.size + this.tails.size) * 160;
  }
  clear() {
    this.starts.clear();
    this.ends.clear();
    this.tails.clear();
  }
  connect(
    key: string,
    first: Point | null,
    last: Point | null,
    startFrame: number,
    endFrame: number,
  ): [Point, Point][] {
    const joins: [Point, Point][] = [];
    if (first) {
      const before = this.ends.get(key + ':' + (startFrame - 1));
      if (before) {
        if (before.visible && first.visible) joins.push([before, first]);
        this.ends.delete(key + ':' + (startFrame - 1));
      } else this.starts.set(key + ':' + startFrame, first);
    }
    if (last) {
      const after = this.starts.get(key + ':' + (endFrame + 1));
      if (after) {
        if (last.visible && after.visible) joins.push([last, after]);
        this.starts.delete(key + ':' + (endFrame + 1));
      } else this.ends.set(key + ':' + endFrame, last);
      const tail = this.tails.get(key);
      if (!tail || tail.frame < last.frame) this.tails.set(key, last);
    }
    if (this.bytes > this.maxBytes)
      throw new GpuError('resource-limit', 'Monitor boundary storage exceeds historyBytes');
    return joins;
  }
  finish() {
    this.starts.clear();
    this.ends.clear();
  }
  seed(tails: ReadonlyMap<string, Point>): void {
    for (const [key, p] of tails) {
      this.ends.set(key + ':' + p.frame, p);
      this.tails.set(key, p);
    }
  }
}
function scalar(
  tile: kit.NativeFields,
  name: string,
  row: number,
  frame: number,
  fallback: number,
): number {
  const c = tile.columns[name];
  if (!c || !bitAt(tile.presence[name], row)) return fallback;
  const stride = c as Partial<SampleColumn>,
    at = c.offset + row * (stride.rowStride ?? 1) + frame * (stride.frameStride ?? 0);
  if (!bitAt(c.validity, at)) return name === 'visible' ? 0 : fallback;
  return c.kind === 'numeric'
    ? c.values[at]
    : c.kind === 'boolean'
      ? bitAt(c.values, at)
        ? 1
        : 0
      : fallback;
}
function rawPoint(tile: kit.NativeFields, row: number, frame: number): Point | null {
  const c = tile.columns.value;
  if (c.kind !== 'numeric' || !bitAt(tile.presence.value, row)) return null;
  const value = sampleAt(c as SampleColumn, { row, frame });
  if (value === null || !Number.isFinite(value)) return null;
  return {
    frame: tile.samples!.firstFrame + frame,
    coordinate: tile.samples!.coordinates[frame],
    value,
    color: scalar(tile, 'color', row, frame, NaN),
    shade: scalar(tile, 'shade', row, frame, 0),
    visible: scalar(tile, 'visible', row, frame, 1) !== 0,
  };
}
export function geometry(
  chunk: Chunk,
  page: kit.GpuPage,
  seams: Seams,
  x: Domain,
  y: Domain,
  colorDomain: Domain | null,
): Geometry {
  const data = chunk.data,
    addresses: number[] = [],
    joins: number[] = [],
    nr = rowCount(page.rows),
    r0 = page.rowOffset - data.rowOffset;
  let count = 0;
  const emit = (row: number, a: number, al: number, b: number, bl: number) => {
    addresses.push(row, a, al, 0, row, b, bl, 0);
    count++;
  };
  const color = kit.resolveScale({}, colorDomain),
    sx = kit.resolveScale({ clamp: false }, x),
    sy = kit.resolveScale({ clamp: false }, y);
  const seam = (a: Point, b: Point) => {
    if (a.frame + 1 !== b.frame || !a.visible || !b.visible) return;
    joins.push(
      kit.scaleValue(a.coordinate, sx)!,
      kit.scaleValue(a.value, sy)!,
      kit.scaleValue(a.color, color) ?? -1,
      a.shade,
      kit.scaleValue(b.coordinate, sx)!,
      kit.scaleValue(b.value, sy)!,
      kit.scaleValue(b.color, color) ?? -1,
      b.shade,
    );
  };
  for (let r = 0; r < nr; r++) {
    const physical = rowAt(page.rows, r),
      key = chunk.binding.name + ':' + physical;
    let first: Point | null = null,
      last: Point | null = null,
      start = 0,
      end = 0;
    if (!isEnvelope(data)) {
      const f0 = page.samples!.firstFrame - data.samples!.firstFrame,
        nf = page.samples!.count;
      first = rawPoint(data, r0 + r, f0);
      last = rawPoint(data, r0 + r, f0 + nf - 1);
      start = page.samples!.firstFrame;
      end = start + nf - 1;
    } else {
      const c = data.columns[chunk.binding.field],
        f0 = page.envelope!.firstBucket - data.firstBucket,
        nf = page.envelope!.count;
      let previous: { point: Point; bucket: number; slot: number } | undefined;
      for (let f = 0; f < nf; f++) {
        const cell = (r0 + r) * data.bucketCount + f0 + f,
          at = cell * 4;
        if (!bitAt(c.values.validity, c.values.offset + at)) continue;
        const slots = [0, 1, 2, 3].sort((a, b) => c.frames[at + a] - c.frames[at + b]);
        let previousFrame = -1;
        const points: { point: Point; slot: number }[] = [];
        for (const slot of slots) {
          const frame = c.frames[at + slot];
          if (frame === previousFrame) continue;
          previousFrame = frame;
          const value = c.values.values[c.values.offset + at + slot],
            style = chunk.styles;
          points.push({
            slot,
            point: {
              frame,
              coordinate: c.coordinates[at + slot],
              value,
              color: chunk.binding.colorValue ? value : (style?.[(r0 + r) * 4] ?? NaN),
              shade: chunk.binding.shadeValue ? value : (style?.[(r0 + r) * 4 + 2] ?? 0),
              visible: (style?.[(r0 + r) * 4 + 1] ?? 1) !== 0,
            },
          });
        }
        if (!points.length) continue;
        const initial = points[0];
        first ??= initial.point;
        start = first.frame;
        if (previous && previous.point.frame + 1 === initial.point.frame)
          emit(r, previous.bucket, previous.slot, f, initial.slot);
        if (bitAt(c.continuous, cell))
          for (let i = 1; i < points.length; i++) emit(r, f, points[i - 1].slot, f, points[i].slot);
        if (points.length === 1 && !previous) emit(r, f, initial.slot, f, initial.slot);
        const tail = points[points.length - 1];
        previous = { point: tail.point, bucket: f, slot: tail.slot };
        last = tail.point;
        end = last.frame;
      }
    }
    for (const [a, b] of seams.connect(key, first, last, start, end)) seam(a, b);
  }
  if (!isEnvelope(data)) count = nr * Math.max(1, page.samples!.count - 1);
  return {
    addresses: buffer(new Uint32Array(addresses), 'monitor connectivity'),
    joins: buffer(new Float32Array(joins), 'monitor boundaries'),
    count,
    joinCount: joins.length / 8,
    raw: !isEnvelope(data),
  };
}
