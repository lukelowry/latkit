import { GpuError, interruptible } from './error.js';

/** Cooperative CPU work: yields to the event loop between slices, stops on abort, and bounds its total time. */
export class Work {
  readonly #started = performance.now();
  #nextYield: number;
  constructor(
    readonly signal: AbortSignal,
    private readonly limitMs = Infinity,
    private readonly sliceMs = 8,
  ) {
    this.#nextYield = this.#started + sliceMs;
  }
  /** Throw when aborted or past the time limit. */
  check(): void {
    this.signal.throwIfAborted();
    if (performance.now() - this.#started > this.limitMs)
      throw new GpuError('resource-limit', 'Work exceeded its time limit');
  }
  /** Yield once the current slice is spent. */
  async step(): Promise<void> {
    this.check();
    if (performance.now() < this.#nextYield) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.#nextYield = performance.now() + this.sliceMs;
    this.check();
  }
  /** Await a task, stopping at abort while still observing its outcome. */
  wait<T>(task: PromiseLike<T>): Promise<T> {
    return interruptible(task, this.signal);
  }
}
