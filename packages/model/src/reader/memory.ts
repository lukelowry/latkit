import { failure } from '../failure.js';

class Held implements Memory.Entry {
  pins = 1;
  live = true;
  retire = false;
  /** When it was last released or used, for choosing between kinds. */
  used = 0;
  constructor(
    readonly pool: Memory,
    readonly backings: readonly ArrayBufferLike[],
    readonly metadata: number,
    readonly dispose: () => void,
    readonly kind: 'cpu' | 'gpu',
  ) {}
  pin(): void {
    if (!this.live || this.retire) throw failure('closed', 'Cached result is closed');
    if (this.pins++ === 0) this.pool.busy(this);
  }
  unpin(): void {
    if (!this.live) return;
    if (this.pins <= 0) throw failure('internal', 'Unbalanced release');
    if (--this.pins) return;
    if (this.retire) this.pool.remove(this);
    else this.pool.idle(this);
  }
  /** Mark a cache hit as just used. */
  touch(): void {
    if (this.live && !this.pins) this.pool.idle(this);
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

/**
 * Least-recently-used accounting of cached reads, uploads, and GPU resources. A buffer that several
 * entries share counts once.
 *
 * The budget bounds what the pool keeps for later, never what is in use: to make room, the pool lets
 * go of what no one holds, least recently used first, and what views hold to draw runs over the
 * budget when it must, until they let it go. So no frame ever fails for want of memory the pool
 * could otherwise have kept. Views bound what they hold with limits of their own.
 */
export class Memory {
  readonly budget: Memory.Budget;
  readonly entries = new Set<Memory.Entry>();
  /** Unpinned entries by kind, least recently used first: eviction takes the first. */
  private readonly lru = { cpu: new Set<Memory.Entry>(), gpu: new Set<Memory.Entry>() };
  private clock = 0;
  private backings = new Map<ArrayBufferLike, { count: number; bytes: number }>();
  private cpu = 0;
  private gpu = 0;
  private staging = 0;
  private peakCpu = 0;
  private peakGpu = 0;
  private peakStaging = 0;
  private staged = 0;
  queries = 0;
  queryHits = 0;
  uploads = 0;
  uploadedBytes = 0;
  uploadHits = 0;
  gpuCopiedBytes = 0;
  allocations = 0;
  submissions = 0;
  evictions = 0;

  constructor(budget: Partial<Memory.Budget> = {}) {
    this.budget = Object.freeze({
      cpuBytes: integer(budget.cpuBytes ?? 128 * 1024 ** 2, 'CPU budget', 1),
      gpuBytes: integer(budget.gpuBytes ?? 256 * 1024 ** 2, 'GPU budget', 4),
      stagingBytes: integer(budget.stagingBytes ?? 24 * 1024 ** 2, 'Staging budget', 4),
      entries: integer(budget.entries ?? 8192, 'Cache entries', 1),
    });
  }

  stats(): Memory.Stats {
    return {
      cpuBytes: this.cpu,
      gpuBytes: this.gpu,
      stagingBytes: this.staging,
      peakCpuBytes: this.peakCpu,
      peakGpuBytes: this.peakGpu,
      peakStagingBytes: this.peakStaging,
      stagedBytes: this.staged,
      entries: this.entries.size,
      queries: this.queries,
      queryHits: this.queryHits,
      uploads: this.uploads,
      uploadedBytes: this.uploadedBytes,
      uploadHits: this.uploadHits,
      gpuCopiedBytes: this.gpuCopiedBytes,
      allocations: this.allocations,
      submissions: this.submissions,
      evictions: this.evictions,
    };
  }

  /** Hold a result: room for it comes from what no one holds, and past that it runs over. */
  add(
    backings: readonly ArrayBufferLike[],
    metadata: number,
    dispose: () => void,
    kind: 'cpu' | 'gpu' = 'cpu',
  ): Memory.Entry {
    const unique = [...new Set(backings)];
    const cost = (): number =>
      metadata +
      unique.reduce((n, buffer) => n + (this.backings.has(buffer) ? 0 : buffer.byteLength), 0);
    while (this.cpu + cost() > this.budget.cpuBytes || this.entries.size >= this.budget.entries)
      if (!this.evict()) break;
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
    const entry = new Held(this, unique, metadata, dispose, kind);
    this.entries.add(entry);
    return entry;
  }

  /** Count a GPU allocation: room for it comes from GPU results no one holds, and past that it runs over. */
  reserveGpu(bytes: number): void {
    integer(bytes, 'GPU allocation bytes', 0);
    while (this.gpu + bytes > this.budget.gpuBytes) if (!this.evict('gpu')) break;
    this.gpu += bytes;
    this.peakGpu = Math.max(this.peakGpu, this.gpu);
    this.allocations++;
  }
  releaseGpu(bytes: number): void {
    this.gpu -= bytes;
  }
  stage<T>(bytes: number, work: () => T): T {
    this.reserveStaging(bytes);
    try {
      return work();
    } finally {
      this.staging -= bytes;
    }
  }
  async stageAsync<T>(bytes: number, work: () => Promise<T>): Promise<T> {
    this.reserveStaging(bytes);
    try {
      return await work();
    } finally {
      this.staging -= bytes;
    }
  }
  /** Transient copies; reads size their blocks to the staging budget, which these never refuse. */
  private reserveStaging(bytes: number): void {
    this.staging += bytes;
    this.staged += bytes;
    this.peakStaging = Math.max(this.peakStaging, this.staging);
  }

  /** An entry no longer held: the most recently used of the evictable. */
  idle(entry: Memory.Entry): void {
    const lru = this.lru[entry.kind];
    lru.delete(entry);
    lru.add(entry);
    entry.used = ++this.clock;
  }
  /** An entry held again: not evictable until released. */
  busy(entry: Memory.Entry): void {
    this.lru[entry.kind].delete(entry);
  }
  /** Evict the least recently used entry, of either kind or only of GPU resources. */
  private evict(kind?: 'gpu'): boolean {
    const [gpu] = this.lru.gpu,
      [cpu] = kind ? [] : this.lru.cpu;
    const oldest = !cpu ? gpu : !gpu ? cpu : cpu.used < gpu.used ? cpu : gpu;
    if (!oldest) return false;
    this.evictions++;
    this.remove(oldest);
    return true;
  }

  remove(entry: Memory.Entry): void {
    if (!entry.live) return;
    entry.live = false;
    this.entries.delete(entry);
    this.lru[entry.kind].delete(entry);
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

  /** Evict everything no one holds. */
  trim(): void {
    // Disposing an entry may release others, which then become evictable too.
    while (this.lru.cpu.size || this.lru.gpu.size)
      for (const entry of [...this.lru.cpu, ...this.lru.gpu]) this.remove(entry);
  }
  destroy(): void {
    for (const entry of [...this.entries]) this.remove(entry);
  }
}

/** A memory pool to share between a reader and a Gpu, so one budget bounds both. */
export function createMemory(budget?: Partial<Memory.Budget>): Memory {
  return new Memory(budget);
}
export declare namespace Memory {
  /**
   * What one memory pool keeps, shared by a reader and the Gpu that reads into it: what no one
   * holds goes first to stay within it, and what is held runs over it rather than fail.
   */
  interface Budget {
    /** Cached reads, uploads, and their bookkeeping. */
    readonly cpuBytes: number;
    readonly gpuBytes: number;
    /** Transient gathers and copies. */
    readonly stagingBytes: number;
    /** Cached results of every kind. */
    readonly entries: number;
  }

  /** Managed allocations of one pool, not process or driver memory estimates. */
  interface Stats {
    readonly cpuBytes: number;
    readonly gpuBytes: number;
    readonly stagingBytes: number;
    readonly peakCpuBytes: number;
    readonly peakGpuBytes: number;
    readonly peakStagingBytes: number;
    readonly stagedBytes: number;
    readonly entries: number;
    readonly queries: number;
    readonly queryHits: number;
    readonly uploads: number;
    readonly uploadedBytes: number;
    readonly uploadHits: number;
    readonly gpuCopiedBytes: number;
    readonly allocations: number;
    readonly submissions: number;
    readonly evictions: number;
  }
  /** One cached result: its backing buffers, held while pinned and evictable once released. */
  interface Entry {
    pins: number;
    live: boolean;
    retire: boolean;
    /** When it was last released or used, for choosing between kinds. */
    used: number;
    readonly pool: Memory;
    readonly backings: readonly ArrayBufferLike[];
    readonly metadata: number;
    readonly dispose: () => void;
    readonly kind: 'cpu' | 'gpu';
    pin(): void;
    unpin(): void;
    /** Mark a cache hit as just used. */
    touch(): void;
    close(): void;
  }
}
