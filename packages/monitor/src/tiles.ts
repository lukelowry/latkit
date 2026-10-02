import { kit } from '@latkit/gpu';
import { bitAt, rowCount, sampleAt, type Domain, type SampleColumn } from '@latkit/model';
import type { Binding } from './bindings.js';
import { isEnvelope, type Chunk } from './history.js';
import type { QueuedChunk } from './job.js';

/** Bounded derived tiles. No producer handles or references to past Data roots. */
export class Tiles {
  private items: {
    trace: string;
    data: Chunk['data'];
    styles?: Float64Array;
    memo: QueuedChunk['memo'];
    buffers: QueuedChunk['buffers'];
    observations: number;
    /** The greatest coordinate this item covers. */
    last: number;
    extent?: Domain | null;
  }[] = [];
  private overflowed = false;
  private buffers = new Set<ArrayBufferLike>();
  private size = 0;
  private complete = false;
  private window: Domain = [0, 0];
  private resolution = 0;
  rows = 0;
  constructor(private readonly limit: number) {}
  get coveredThrough(): number | undefined {
    return this.complete ? this.window[1] : undefined;
  }
  get bytes(): number {
    return this.size;
  }
  clear(): void {
    this.items = [];
    this.buffers.clear();
    this.size = 0;
    this.complete = false;
    this.rows = 0;
    this.resolution = 0;
    this.overflowed = false;
  }
  add(entry: QueuedChunk, window: Domain): void {
    if (window[0] > this.window[0]) this.prune(window[0]);
    const extra = [...entry.buffers].reduce(
      (n, b) => n + (this.buffers.has(b) ? 0 : b.byteLength),
      256,
    );
    const geometry = [...entry.memo.values()].reduce(
      (n, g) => n + g.addresses.size + g.joins.size,
      0,
    );
    if (this.overflowed) return;
    if (this.size + extra + geometry > this.limit) {
      this.clear();
      this.overflowed = true;
      return;
    }
    this.size += extra + geometry;
    for (const backing of entry.buffers) this.buffers.add(backing);
    const { binding, data, styles } = entry.chunk;
    this.items.push({
      trace: binding.name,
      data,
      styles,
      memo: entry.memo,
      buffers: entry.buffers,
      observations: entry.observations,
      last: lastCoordinate(data),
    });
  }
  finish(window: Domain, pixels: number, rows: number, complete: boolean): void {
    if (!complete || this.overflowed) return;
    const previousResolution = this.complete ? this.resolution : 0;
    this.window = this.complete
      ? [Math.min(this.window[0], window[0]), Math.max(this.window[1], window[1])]
      : [...window];
    this.complete = true;
    this.rows = rows;
    this.resolution =
      previousResolution ||
      (this.items.some((item) => isEnvelope(item.data))
        ? (window[1] - window[0]) / Math.max(1, pixels)
        : 0);
  }
  /** Exact cached extrema; only partly covered summary buckets need local refinement. */
  async bounds(
    trace: string,
    window: Domain,
    signal: AbortSignal,
  ): Promise<{ domain: Domain | null; missing: Domain[] } | undefined> {
    if (!this.complete || window[0] < this.window[0]) return;
    const work = new kit.Work(signal, Infinity, 3);
    let lo = Infinity,
      hi = -Infinity;
    const missing: Domain[] =
      window[1] > this.window[1] ? [[Math.max(window[0], this.window[1]), window[1]]] : [];
    for (const item of this.items) {
      if (item.trace !== trace) continue;
      work.check();
      let low = Infinity,
        high = -Infinity,
        whole = true;
      const add = (value: number | null) => {
        if (value !== null && Number.isFinite(value)) {
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      };
      if (isEnvelope(item.data)) {
        const column = Object.values(item.data.columns)[0];
        for (let cell = 0; cell < rowCount(item.data.rows) * item.data.bucketCount; cell++) {
          const start = cell * 4;
          if (!bitAt(column.values.validity, column.values.offset + start)) continue;
          const first = Math.min(...column.coordinates.subarray(start, start + 4)),
            last = Math.max(...column.coordinates.subarray(start, start + 4));
          if (last < window[0] || first > window[1]) {
            whole = false;
            continue;
          }
          if (first < window[0] || last > window[1]) {
            whole = false;
            missing.push([Math.max(first, window[0]), Math.min(last, window[1])]);
            continue;
          }
          for (let lane = 0; lane < 4; lane++)
            add(column.values.values[column.values.offset + start + lane]);
        }
      } else {
        const coordinates = item.data.samples!.coordinates,
          column = item.data.columns.value;
        whole = coordinates[0] >= window[0] && coordinates.at(-1)! <= window[1];
        if (whole && item.extent !== undefined) {
          if (item.extent) {
            low = item.extent[0];
            high = item.extent[1];
          }
        } else if (column.kind === 'numeric') {
          for (let f = 0; f < coordinates.length; f++) {
            if (coordinates[f] < window[0] || coordinates[f] > window[1]) continue;
            for (let r = 0; r < rowCount(item.data.rows); r++)
              if (bitAt(item.data.presence.value, r))
                add(sampleAt(column as SampleColumn, { row: r, frame: f }));
          }
        }
      }
      const domain: Domain | null = low <= high ? [low, high] : null;
      if (whole) item.extent = domain;
      if (domain) {
        lo = Math.min(lo, domain[0]);
        hi = Math.max(hi, domain[1]);
      }
      await work.step();
    }
    return { domain: lo <= hi ? [lo, hi] : null, missing: coordinateRanges(missing) };
  }
  private prune(before: number): void {
    const kept = this.items.filter((item) => item.last >= before);
    if (kept.length < this.items.length) {
      this.items = kept;
      this.buffers.clear();
      this.size = 0;
      for (const item of kept) {
        this.size += 256;
        for (const buffer of item.buffers)
          if (!this.buffers.has(buffer)) {
            this.buffers.add(buffer);
            this.size += buffer.byteLength;
          }
        for (const geometry of item.memo.values())
          this.size += geometry.addresses.size + geometry.joins.size;
      }
    }
    this.window = [Math.max(before, this.window[0]), this.window[1]];
  }
  reuse(
    window: Domain,
    pixels: number,
    bindings: readonly Binding[],
    extending = false,
  ): readonly QueuedChunk[] | undefined {
    if (
      !this.complete ||
      window[0] < this.window[0] ||
      (!extending && window[1] > this.window[1]) ||
      this.resolution > ((window[1] - window[0]) / Math.max(1, pixels)) * 1.01
    )
      return;
    const byName = new Map(bindings.map((binding) => [binding.name, binding]));
    if (this.items.some((item) => !byName.has(item.trace))) return;
    return this.items
      .filter((item) => item.last >= window[0])
      .map((item) => ({
        cached: true,
        chunk: { data: item.data, styles: item.styles, binding: byName.get(item.trace)! },
        memo: item.memo,
        buffers: item.buffers,
        observations: item.observations,
      }));
  }
}

/** Raw tiles hold ascending coordinates; summaries hold them per bucket lane. */
function lastCoordinate(data: Chunk['data']): number {
  if (!isEnvelope(data)) return data.samples!.coordinates.at(-1) ?? Infinity;
  let last = -Infinity;
  for (const column of Object.values(data.columns))
    for (const coordinate of column.coordinates) if (coordinate > last) last = coordinate;
  return last;
}

export function coordinateRanges(ranges: readonly Domain[]): Domain[] {
  const out: [number, number][] = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = out.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else out.push([range[0], range[1]]);
  }
  return out;
}
