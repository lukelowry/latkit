import type { Chunk, HistoryRequest } from './history.js';
import { history } from './history.js';
import { split, Seams, type Geometry } from './segments.js';
import { deferred, wait } from './async.js';
import type { Image } from './rendering/painter.js';
/** One borrowed block at a time. Only submission acknowledges consumption. */
export class Job {
  readonly stop = new AbortController();
  readonly seams: Seams;
  readonly memo = new Map<string, Geometry>();
  ready?: Chunk;
  done = false;
  error?: unknown;
  private next = deferred();
  private consumed = deferred();
  readonly completion: Promise<void>;
  readonly versions = new Map<import('@latkit/model').Queryable, string>();
  work = 4096;
  rows=0;
  timeMs = 0;
  pointer: readonly [number, number] | null = null;
  parameters = new Float32Array(64);
  constructor(
    readonly target: Image,
    request: Omit<HistoryRequest, 'signal'>,
    private readonly changed: () => void,
    seed?: Seams,
  ) {
    this.seams = new Seams(request.limits.historyBytes);
    if (seed) this.seams.seed(seed.tails);
    this.completion = this.run(request);
    void this.completion.catch(() => {});
  }
  get pending(): Promise<void> | undefined {
    return this.ready || this.done ? undefined : this.next.promise;
  }
  private async run(request: Omit<HistoryRequest, 'signal'>) {
    try {
      for await (const block of history({ ...request, signal: this.stop.signal,onRows:rows=>{this.rows=rows;} }))
        for (const chunk of split(block, Math.min(request.limits.segmentsPerFrame, this.work))) {
          this.stop.signal.throwIfAborted();
          const versions =
            'kind' in chunk.data
              ? new Map([[chunk.binding.source, chunk.data.version]])
              : chunk.data.versions;
          for (const [source, version] of versions) {
            const previous = this.versions.get(source);
            if (previous !== undefined && previous !== version)
              throw new Error('History changed during preparation');
            this.versions.set(source, version);
          }
          this.ready = chunk;
          this.next.resolve();
          this.changed();
          await wait(this.consumed.promise, this.stop.signal);
          this.consumed = deferred();
        }
    } catch (error) {
      if (!this.stop.signal.aborted) this.error = error;
    } finally {
      this.done = true;
      this.next.resolve();
      if (!this.stop.signal.aborted) this.changed();
    }
  }
  tune(elapsed: number, budget: number) {
    const ratio = Math.max(0.25, Math.min(2, budget / Math.max(0.1, elapsed)));
    this.work = Math.max(256, Math.min(16384, Math.floor(this.work * ratio)));
  }
  consume() {
    this.ready = undefined;
    this.memo.clear();
    this.next = deferred();
    this.consumed.resolve();
  }
  cancel() {
    this.stop.abort(new DOMException('Monitor history superseded', 'AbortError'));
    this.next.resolve();
    this.consumed.resolve();
  }
}
