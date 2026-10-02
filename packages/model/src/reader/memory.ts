import { failure } from '../error.js';

export interface ReaderStats {
  readonly cpuBytes: number;
  readonly peakCpuBytes: number;
  readonly stagingBytes: number;
  readonly peakStagingBytes: number;
  readonly stagedBytes: number;
  readonly entries: number;
  readonly queries: number;
  readonly queryHits: number;
  readonly evictions: number;
}

export class Entry {
  pins = 1;
  live = true;
  retire = false;
  touched = 0;
  constructor(
    readonly pool: Memory,
    readonly backings: readonly ArrayBufferLike[],
    readonly metadata: number,
    readonly dispose: () => void,
  ) {}
  pin(): void {
    if (!this.live || this.retire) throw failure('closed', 'Read result is closed');
    this.pins++;
    this.touched = ++this.pool.clock;
  }
  unpin(): void {
    if (!this.live) return;
    if (this.pins <= 0) throw new Error('Unbalanced read release');
    this.pins--;
    if (!this.pins && this.retire) this.pool.remove(this);
  }
  close(): void {
    this.retire = true;
    if (!this.pins) this.pool.remove(this);
  }
}

function integer(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw failure('invalid-input', `${label} must be an integer of at least ${minimum}`);
  return value;
}

/** Bounded least-recently-used accounting of memoized reads. Numbers describe managed bytes only. */
export class Memory {
  readonly cpuBytes: number;
  readonly stagingBytes: number;
  readonly maxEntries: number;
  readonly entries = new Set<Entry>();
  private backings = new Map<ArrayBufferLike, { count: number; bytes: number }>();
  private cpu = 0;
  private staging = 0;
  private peakCpu = 0;
  private peakStaging = 0;
  private staged = 0;
  clock = 0;
  queries = 0;
  queryHits = 0;
  evictions = 0;

  constructor(options: { cpuBytes?: number; stagingBytes?: number; entries?: number } = {}) {
    this.cpuBytes = integer(options.cpuBytes ?? 64 * 1024 ** 2, 'Read budget', 1);
    this.stagingBytes = integer(options.stagingBytes ?? 8 * 1024 ** 2, 'Staging budget', 4);
    this.maxEntries = integer(options.entries ?? 4096, 'Read entries', 1);
  }

  stats(): ReaderStats {
    return {
      cpuBytes: this.cpu,
      peakCpuBytes: this.peakCpu,
      stagingBytes: this.staging,
      peakStagingBytes: this.peakStaging,
      stagedBytes: this.staged,
      entries: this.entries.size,
      queries: this.queries,
      queryHits: this.queryHits,
      evictions: this.evictions,
    };
  }

  add(backings: readonly ArrayBufferLike[], metadata: number, dispose: () => void): Entry {
    const unique = [...new Set(backings)];
    if (metadata + unique.reduce((n, buffer) => n + buffer.byteLength, 0) > this.cpuBytes)
      throw failure('resource-limit', 'Read result exceeds the read budget');
    const cost = (): number =>
      metadata +
      unique.reduce((n, buffer) => n + (this.backings.has(buffer) ? 0 : buffer.byteLength), 0);
    while (this.cpu + cost() > this.cpuBytes || this.entries.size >= this.maxEntries)
      if (!this.evict())
        throw failure('resource-limit', 'Read budget or entry limit exceeded by held results');
    for (const buffer of unique) {
      const existing = this.backings.get(buffer);
      if (existing) existing.count++;
      else {
        this.backings.set(buffer, { count: 1, bytes: buffer.byteLength });
        this.cpu += buffer.byteLength;
      }
    }
    this.cpu += metadata;
    this.peakCpu = Math.max(this.peakCpu, this.cpu);
    const entry = new Entry(this, unique, metadata, dispose);
    entry.touched = ++this.clock;
    this.entries.add(entry);
    return entry;
  }

  stage<T>(bytes: number, work: () => T): T {
    if (this.staging + bytes > this.stagingBytes)
      throw failure('resource-limit', 'Staging budget exceeded');
    this.staging += bytes;
    this.staged += bytes;
    this.peakStaging = Math.max(this.peakStaging, this.staging);
    try {
      return work();
    } finally {
      this.staging -= bytes;
    }
  }

  private evict(): boolean {
    let oldest: Entry | undefined;
    for (const entry of this.entries)
      if (!entry.pins && (!oldest || entry.touched < oldest.touched)) oldest = entry;
    if (!oldest) return false;
    this.evictions++;
    this.remove(oldest);
    return true;
  }

  remove(entry: Entry): void {
    if (!entry.live) return;
    entry.live = false;
    this.entries.delete(entry);
    this.cpu -= entry.metadata;
    for (const buffer of entry.backings) {
      const held = this.backings.get(buffer)!;
      if (--held.count === 0) {
        this.cpu -= held.bytes;
        this.backings.delete(buffer);
      }
    }
    entry.dispose();
  }

  trim(): void {
    let previous: number;
    do {
      previous = this.entries.size;
      for (const entry of [...this.entries]) if (!entry.pins) this.remove(entry);
    } while (this.entries.size < previous);
  }
  destroy(): void {
    for (const entry of [...this.entries]) this.remove(entry);
  }
}
