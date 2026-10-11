/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- Preserve native AbortSignal reasons. */
import { failure } from './failure.js';

/** Stop waiting on cancellation while still observing the work's outcome. */
export function interruptible<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

interface Scheduler {
  readonly yield?: () => Promise<void>;
  readonly postTask?: (
    task: () => void,
    options: { readonly priority: 'background' },
  ) => Promise<void>;
}
/**
 * Let other tasks run, then continue. In the foreground, `scheduler.yield()` resumes ahead of other
 * queued tasks and without the timer clamp nested timeouts get; in the background,
 * `scheduler.postTask` resumes behind them. Elsewhere this waits for a timeout.
 */
export function yieldTask(priority: Work.Priority = 'foreground'): Promise<void> {
  const scheduler = (globalThis as { readonly scheduler?: Scheduler }).scheduler;
  if (priority === 'background' && scheduler?.postTask)
    return scheduler.postTask(() => {}, { priority: 'background' });
  if (priority === 'foreground' && scheduler?.yield) return scheduler.yield();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Cooperative CPU work: yields to the event loop between slices, stops on abort, and bounds its total time. */
export class Work {
  readonly #started = performance.now();
  #nextYield: number;
  constructor(
    readonly signal: AbortSignal,
    private readonly limitMs = Infinity,
    private readonly sliceMs = 8,
    private readonly priority: Work.Priority = 'foreground',
  ) {
    this.#nextYield = this.#started + sliceMs;
  }
  /** Throw when aborted or past the time limit. */
  check(): void {
    this.signal.throwIfAborted();
    if (performance.now() - this.#started > this.limitMs)
      throw failure('resource-limit', 'Work exceeded its time limit');
  }
  /** Yield once the current slice is spent. */
  async step(): Promise<void> {
    this.check();
    if (performance.now() < this.#nextYield) return;
    await yieldTask(this.priority);
    this.#nextYield = performance.now() + this.sliceMs;
    this.check();
  }
  /** Await a task, stopping at abort while still observing its outcome. */
  wait<T>(task: PromiseLike<T>): Promise<T> {
    return interruptible(task, this.signal);
  }
}
export declare namespace Work {
  /**
   * How work shares the page: `foreground` work someone waits on resumes ahead of other queued
   * tasks; `background` work resumes after them, so a frame waiting on the GPU never waits on it.
   */
  type Priority = 'foreground' | 'background';
}
