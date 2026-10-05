import { failure } from '@latkit/model';
import { integer } from '../error.js';

export interface ByteRange {
  readonly offset: number;
  readonly size: number;
}
interface Revision {
  readonly revision: number;
  readonly ranges: readonly ByteRange[];
}

/** Mutable renderer data. Writes are byte-addressed; each consumer tracks its own revision. */
export class BufferData {
  private storage: Uint8Array<ArrayBuffer>;
  private used: number;
  private serial = 0;
  private history: Revision[] = [];
  readonly usage: GPUBufferUsageFlags;
  readonly label: string;

  constructor(options: {
    readonly size: number;
    readonly usage?: GPUBufferUsageFlags;
    readonly label?: string;
  }) {
    this.used = integer(options.size, 'buffer size');
    this.storage = new Uint8Array(this.used);
    this.usage = options.usage ?? GPUBufferUsage.STORAGE;
    this.label = options.label ?? 'renderer data';
  }

  get bytes(): Uint8Array<ArrayBuffer> {
    return this.storage.subarray(0, this.used);
  }
  get size(): number {
    return this.used;
  }
  get capacity(): number {
    return this.storage.byteLength;
  }
  get revision(): number {
    return this.serial;
  }

  resize(size: number): void {
    integer(size, 'buffer size');
    if (size === this.used) return;
    if (size > this.capacity) {
      const next = new Uint8Array(Math.max(size, Math.ceil(this.capacity * 1.5)));
      next.set(this.storage.subarray(0, this.used));
      this.storage = next;
    } else if (size > this.used) this.storage.fill(0, this.used, size);
    this.used = size;
    this.touch({ offset: 0, size });
  }

  write(options: { readonly data: ArrayBufferView; readonly offset?: number }): void {
    const offset = integer(options.offset ?? 0, 'write offset');
    if (offset + options.data.byteLength > this.used)
      throw failure('invalid-input', 'Write exceeds buffer size');
    this.storage.set(
      new Uint8Array(options.data.buffer, options.data.byteOffset, options.data.byteLength),
      offset,
    );
    this.touch({ offset, size: options.data.byteLength });
  }

  /**
   * Hold exactly `values`, resizing to fit, and mark only what differs as changed, so a consumer
   * uploads what moved rather than everything. `stride` bytes compare as one record: a record with
   * any changed word changes whole, and changed neighbors join one range. One revision records it.
   */
  update(values: ArrayBufferView, stride = 4): void {
    if (values.byteLength % 4 || values.byteOffset % 4 || stride % 4 || stride <= 0)
      throw failure('invalid-input', 'Updates are whole, aligned words');
    this.resize(Math.max(4, values.byteLength));
    const next = new Uint32Array(values.buffer, values.byteOffset, values.byteLength / 4),
      held = new Uint32Array(this.storage.buffer, this.storage.byteOffset, next.length),
      step = stride / 4,
      ranges: { offset: number; size: number }[] = [];
    for (let record = 0; record < next.length; record += step) {
      const end = Math.min(record + step, next.length);
      let same = true;
      for (let i = record; same && i < end; i++) same = held[i] === next[i];
      if (same) continue;
      held.set(next.subarray(record, end), record);
      const last = ranges.at(-1);
      if (last && last.offset + last.size === record * 4) last.size += (end - record) * 4;
      else ranges.push({ offset: record * 4, size: (end - record) * 4 });
    }
    if (!ranges.length) return;
    this.history.push({ revision: ++this.serial, ranges });
    if (this.history.length > 64) this.history.shift();
  }

  /** Call after editing bytes directly. Empty touches still advance the revision. */
  touch(range: ByteRange = { offset: 0, size: this.used }): void {
    integer(range.offset, 'dirty offset', 0, this.used);
    integer(range.size, 'dirty size', 0, this.used - range.offset);
    this.history.push({ revision: ++this.serial, ranges: range.size ? [{ ...range }] : [] });
    if (this.history.length > 64) this.history.shift();
  }

  /** A bounded change journal; old consumers receive the full used range. */
  changesSince(revision: number): readonly ByteRange[] {
    if (revision === this.serial) return [];
    if (revision > this.serial || revision < (this.history[0]?.revision ?? this.serial + 1) - 1)
      return this.used ? [{ offset: 0, size: this.used }] : [];
    const sorted = this.history
      .filter((item) => item.revision > revision)
      .flatMap((item) => item.ranges)
      .map((range) => ({
        offset: range.offset,
        size: Math.max(0, Math.min(range.size, this.used - range.offset)),
      }))
      .filter((range) => range.size > 0)
      .sort((a, b) => a.offset - b.offset);
    const merged: { offset: number; size: number }[] = [];
    for (const range of sorted) {
      const last = merged.at(-1);
      if (last && range.offset <= last.offset + last.size + 64)
        last.size = Math.max(last.size, range.offset + range.size - last.offset);
      else merged.push(range);
    }
    return merged.length <= 16
      ? merged
      : [
          {
            offset: merged[0].offset,
            size: merged.at(-1)!.offset + merged.at(-1)!.size - merged[0].offset,
          },
        ];
  }
}
