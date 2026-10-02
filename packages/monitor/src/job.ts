import { GpuError } from '@latkit/gpu';
import { rowCount } from '@latkit/model';
import type { Chunk, HistoryRequest } from './history.js';
import { history, isEnvelope } from './history.js';
import { split, Seams, type Geometry } from './segments.js';
import { deferred, wait } from './async.js';
import type { Image } from './rendering/painter.js';
import { Coverage } from './coverage.js';

export interface QueuedChunk {
  readonly cached?: boolean;
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
  work = 4096;
  rows = 0;
  timeMs = 0;
  pointer: readonly [number, number] | null = null;
  parameters = new Float32Array(64);
  readonly maxBytes: number;
  constructor(
    readonly target: Image,
    request: Omit<HistoryRequest, 'reads'>,
    private readonly changed: () => void,
    seed?: Seams,
    private readonly reuse?: { entries: readonly QueuedChunk[]; rows: number; readNew: boolean },
  ) {
    this.seams = new Seams(request.limits.historyBytes);
    if (seed) this.seams.seed(seed.tails);
    this.maxBytes = Math.max(
      1,
      Math.min(8 * 1024 ** 2, request.gpu.budget.cpuBytes / 8, request.limits.historyBytes / 4),
    );
    this.rows = reuse?.rows ?? 0;
    this.completion = this.run(request);
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
  private async *entries(request: Omit<HistoryRequest, 'reads'>): AsyncGenerator<QueuedChunk> {
    if (this.reuse) yield* this.reuse.entries;
    if (this.reuse && !this.reuse.readNew) return;
    const reads = request.gpu.reader.open({ signal: this.stop.signal });
    try {
      for await (const block of history({
        ...request,
        reads,
        onRows: (rows) => {
          this.rows = Math.max(this.reuse?.rows ?? 0, rows);
        },
      })) {
        this.held = backing([block.data, block.styles]);
        if ([...this.held].reduce((n, b) => n + b.byteLength, 256) > this.maxBytes / 2)
          throw new GpuError(
            'resource-limit',
            'Native backing exceeds monitor read-ahead capacity',
          );
        const original = request.bindings.find((b) => b.name === block.binding.name)!;
        for (const chunk of split(
          { ...block, binding: original },
          Math.min(request.limits.segmentsPerFrame, this.work),
        )) {
          const data = chunk.data;
          yield {
            chunk,
            buffers: backing([chunk.data, chunk.styles]),
            memo: new Map(),
            observations:
              rowCount(data.rows) *
              (isEnvelope(data) ? data.bucketCount * 4 : data.samples!.coordinates.length),
          };
        }
        this.held.clear();
      }
    } finally {
      reads.close();
    }
  }
  private async run(request: Omit<HistoryRequest, 'reads'>) {
    try {
      for await (const entry of this.entries(request)) {
        this.stop.signal.throwIfAborted();
        const { buffers } = entry;
        if ([...buffers].reduce((n, b) => n + b.byteLength, 256) > this.maxBytes / 2)
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
        this.queue.push(entry);
        this.peakBytes = Math.max(this.peakBytes, this.bytes);
        this.next.resolve();
        this.changed();
      }
    } catch (error) {
      if (!this.stop.signal.aborted) this.error = error;
    } finally {
      this.held.clear();
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
