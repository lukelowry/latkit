import { GpuError } from '@latkit/gpu';
import { rowCount } from '@latkit/model';
import type { Chunk, HistoryRequest } from './history.js';
import { history, isEnvelope } from './history.js';
import { split, Seams, type Geometry } from './segments.js';
import { deferred, wait } from './async.js';
import type { Image } from './rendering/painter.js';
import type { Sources } from './sources.js';
import { Coverage } from './coverage.js';

export interface QueuedChunk {
  readonly chunk: Chunk;
  readonly memo: Map<string, Geometry>;
  readonly buffers: Set<ArrayBufferLike>;
  readonly observations: number;
}
function backing(value: unknown, buffers = new Set<ArrayBufferLike>()): Set<ArrayBufferLike> {
  if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  else if (value && typeof value === 'object' && !(value instanceof Map))
    for (const child of Object.values(value)) backing(child, buffers);
  return buffers;
}
/** Bounded read-ahead. Queued entries remain replayable until successful submission. */
export class Job {
  readonly stop = new AbortController();
  readonly seams: Seams;
  readonly coverage = new Coverage();
  readonly endFrames = new Map<import('@latkit/model').Queryable, number>();
  readonly queue: QueuedChunk[] = [];
  private finished = false;
  error?: unknown;
  private next = deferred();
  private space = deferred();
  private buffers = new Map<ArrayBufferLike, number>();
  private queuedBytes = 0;
  private held = new Set<ArrayBufferLike>();
  get bytes() {
    return (
      this.queuedBytes +
      [...this.held].reduce((n, b) => n + (this.buffers.has(b) ? 0 : b.byteLength), 0)
    );
  }
  peakBytes = 0;
  readonly completion: Promise<void>;
  readonly versions = new Map<import('@latkit/model').Queryable, string>();
  work = 4096;
  rows = 0;
  timeMs = 0;
  pointer: readonly [number, number] | null = null;
  parameters = new Float32Array(64);
  readonly maxBytes: number;
  constructor(
    readonly target: Image,
    request: Omit<HistoryRequest, 'signal'>,
    private readonly changed: () => void,
    sources: Sources,
    seed?: Seams,
  ) {
    this.seams = new Seams(request.limits.historyBytes);
    if (seed) this.seams.seed(seed.tails);
    this.maxBytes = Math.max(
      1,
      Math.min(8 * 1024 ** 2, request.gpu.budget.cpuBytes / 8, request.limits.historyBytes / 4),
    );
    this.completion = this.run(request, sources);
    void this.completion.catch(() => {});
  }
  get ready() {
    return this.queue.length > 0;
  }
  get done() {
    return this.completeAfter(0);
  }
  completeAfter(count: number) {
    return this.finished && count === this.queue.length && !this.error;
  }
  get pending(): Promise<void> | undefined {
    return this.ready || this.done ? undefined : this.next.promise;
  }
  private async run(request: Omit<HistoryRequest, 'signal'>, sources: Sources) {
    let release: (() => void) | undefined;
    try {
      const fixed = await sources.acquire(request, this.stop.signal);
      release = fixed.release;
      for await (const block of history({
        ...fixed.request,
        signal: this.stop.signal,
        onRows: (rows) => {
          this.rows = rows;
        },
      })) {
        this.held = backing([block.data, block.styles]);
        if ([...this.held].reduce((n, b) => n + b.byteLength, 256) > this.maxBytes / 2)
          throw new GpuError(
            'resource-limit',
            'Native backing exceeds monitor read-ahead capacity',
          );
        const original = request.bindings.find((b) => b.name === block.binding.name)!;
        const versions = isEnvelope(block.data)
          ? new Map([[block.binding.source, block.data.version]])
          : block.data.versions;
        for (const [source, version] of versions)
          this.versions.set(fixed.originals.get(source) ?? source, version);
        for (const chunk of split(
          { ...block, binding: original },
          Math.min(request.limits.segmentsPerFrame, this.work),
        )) {
          this.stop.signal.throwIfAborted();
          const buffers = backing([chunk.data, chunk.styles]);
          const total = [...buffers].reduce((n, b) => n + b.byteLength, 256);
          if (total > this.maxBytes / 2)
            throw new GpuError(
              'resource-limit',
              'Native block backing exceeds monitor read-ahead capacity',
            );
          const extra = () =>
            [...buffers].reduce((n, b) => n + (this.buffers.has(b) ? 0 : b.byteLength), 256);
          while (this.queue.length >= 32 || this.queuedBytes + extra() > this.maxBytes / 2)
            await wait(this.space.promise, this.stop.signal);
          this.stop.signal.throwIfAborted();
          this.queuedBytes += extra();
          for (const b of buffers) this.buffers.set(b, (this.buffers.get(b) ?? 0) + 1);
          const data = chunk.data;
          this.queue.push({
            chunk,
            buffers,
            memo: new Map(),
            observations:
              rowCount(data.rows) *
              (isEnvelope(data) ? data.bucketCount * 4 : data.samples!.coordinates.length),
          });
          this.peakBytes = Math.max(this.peakBytes, this.bytes);
          this.next.resolve();
          this.changed();
        }
        this.held.clear();
      }
    } catch (error) {
      if (!this.stop.signal.aborted) this.error = error;
    } finally {
      this.held.clear();
      release?.();
      this.finished = true;
      this.next.resolve();
      if (!this.stop.signal.aborted) this.changed();
    }
  }
  tune(elapsed: number, budget: number) {
    const ratio = Math.max(0.25, Math.min(2, budget / Math.max(0.1, elapsed)));
    this.work = Math.max(256, Math.min(16384, Math.floor(this.work * ratio)));
  }
  consume(count: number) {
    for (const item of this.queue.splice(0, count)) {
      this.coverage.add(item.chunk);
      const d = item.chunk.data;
      const source = item.chunk.binding.source;
      let end = this.endFrames.get(source) ?? -Infinity;
      if (isEnvelope(d))
        for (const n of d.columns[item.chunk.binding.field].frames) end = Math.max(end, n);
      else end = Math.max(end, d.samples!.firstFrame + d.samples!.coordinates.length - 1);
      this.endFrames.set(source, end);
      this.queuedBytes -= 256;
      for (const b of item.buffers) {
        const n = this.buffers.get(b)! - 1;
        if (n) this.buffers.set(b, n);
        else {
          this.buffers.delete(b);
          this.queuedBytes -= b.byteLength;
        }
      }
    }
    if (!this.queue.length) this.next = deferred();
    this.space.resolve();
    this.space = deferred();
  }
  cancel() {
    this.stop.abort(new DOMException('Monitor history superseded', 'AbortError'));
    this.next.resolve();
    this.space.resolve();
    this.queue.length = 0;
    this.buffers.clear();
    this.queuedBytes = 0;
    this.held.clear();
  }
}
