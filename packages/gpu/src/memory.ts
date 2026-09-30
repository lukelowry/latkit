import { GpuError, integer } from './error.js';

export interface Budget {
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly stagingBytes: number;
  readonly entries: number;
}

export interface GpuStats {
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
  readonly allocations: number;
  readonly submissions: number;
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
    readonly kind: 'cpu' | 'gpu',
  ) {}
  pin(): void {
    if (!this.live || this.retire) throw new GpuError('closed', 'Rendering resource is closed');
    this.pins++;
    this.touched = ++this.pool.clock;
  }
  unpin(): void {
    if (!this.live) return;
    if (this.pins <= 0) throw new Error('Unbalanced resource release');
    this.pins--;
    if (!this.pins && this.retire) this.pool.remove(this);
  }
  close(): void {
    this.retire = true;
    if (!this.pins) this.pool.remove(this);
  }
}

/** All numbers describe managed allocations, not process/driver memory estimates. */
export class Memory {
  readonly budget: Budget;
  readonly entries = new Set<Entry>();
  private backings = new Map<ArrayBufferLike, { count: number; bytes: number }>();
  private cpu = 0;
  private gpu = 0;
  private staging = 0;
  private peakCpu = 0;
  private peakGpu = 0;
  private peakStaging = 0;
  private staged = 0;
  clock = 0;
  queries = 0;
  queryHits = 0;
  uploads = 0;
  uploadedBytes = 0;
  uploadHits = 0;
  allocations = 0;
  submissions = 0;
  evictions = 0;

  constructor(budget: Partial<Budget> = {}) {
    this.budget = {
      cpuBytes: integer(budget.cpuBytes ?? 64 * 1024 ** 2, 'CPU budget', 1),
      gpuBytes: integer(budget.gpuBytes ?? 256 * 1024 ** 2, 'GPU budget', 4),
      stagingBytes: integer(budget.stagingBytes ?? 16 * 1024 ** 2, 'staging budget', 4),
      entries: integer(budget.entries ?? 4096, 'cache entries', 1),
    };
  }

  stats(): GpuStats {
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
      allocations: this.allocations,
      submissions: this.submissions,
      evictions: this.evictions,
    };
  }

  add(
    backings: readonly ArrayBufferLike[],
    metadata: number,
    dispose: () => void,
    kind: 'cpu' | 'gpu' = 'cpu',
  ): Entry {
    const unique = [...new Set(backings)];
    if (metadata + unique.reduce((n, buffer) => n + buffer.byteLength, 0) > this.budget.cpuBytes)
      throw new GpuError('resource-limit', 'Entry exceeds the CPU budget');
    const cost = (): number =>
      metadata +
      unique.reduce((n, buffer) => n + (this.backings.has(buffer) ? 0 : buffer.byteLength), 0);
    while (this.cpu + cost() > this.budget.cpuBytes || this.entries.size >= this.budget.entries) {
      if (!this.evict())
        throw new GpuError('resource-limit', 'CPU cache or entry budget exceeded by pinned data');
    }
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
    const entry = new Entry(this, unique, metadata, dispose, kind);
    entry.touched = ++this.clock;
    this.entries.add(entry);
    return entry;
  }

  reserveGpu(bytes: number): void {
    integer(bytes, 'GPU allocation bytes');
    if (bytes > this.budget.gpuBytes)
      throw new GpuError('resource-limit', 'Allocation exceeds the GPU budget');
    while (this.gpu + bytes > this.budget.gpuBytes) {
      if (!this.evict('gpu'))
        throw new GpuError('resource-limit', 'GPU budget exceeded by live or in-flight resources');
    }
    this.gpu += bytes;
    this.peakGpu = Math.max(this.peakGpu, this.gpu);
    this.allocations++;
  }
  releaseGpu(bytes: number): void {
    this.gpu -= bytes;
  }

  stage<T>(bytes: number, work: () => T): T {
    if (this.staging + bytes > this.budget.stagingBytes)
      throw new GpuError('resource-limit', 'Staging budget exceeded');
    this.staging += bytes;
    this.staged += bytes;
    this.peakStaging = Math.max(this.peakStaging, this.staging);
    try {
      return work();
    } finally {
      this.staging -= bytes;
    }
  }

  private evict(kind?: 'gpu'): boolean {
    let oldest: Entry | undefined;
    for (const entry of this.entries)
      if (
        !entry.pins &&
        (!kind || entry.kind === kind) &&
        (!oldest || entry.touched < oldest.touched)
      )
        oldest = entry;
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
    for (const entry of [...this.entries]) if (!entry.pins) this.remove(entry);
  }
  destroy(): void {
    for (const entry of [...this.entries]) this.remove(entry);
  }
}
