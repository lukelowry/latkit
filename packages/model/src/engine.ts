/**
 * An engine: what records a model. Attach one to a model; the model's `record` runs it in turn,
 * and a transport runs it into a recorder that forwards.
 */

import type { Domain } from './domain.js';
import type { Model } from './model.js';

/** One recording waiting its turn. */
interface Waiting {
  readonly recorder: Engine.Recorder;
  start(): void;
  leave(): void;
}

/**
 * What records a model: a simulator, a solver, an analysis, a feed. Subclass it: `parse` what an
 * input may be, and `execute` one, writing frames through the recorder. Attach it to a model,
 * whose `record` runs it; the base runs as many at once as its concurrency allows and queues the
 * rest in order, telling each how many wait before it.
 */
export abstract class Engine {
  /** Recordings it makes at once; the rest wait their turn, in order. */
  readonly concurrency: number;
  #running = 0;
  readonly #waiting: Waiting[] = [];

  /**
   * @param options - `concurrency`: recordings it makes at once, `Infinity` for an engine that
   * queues for itself. @defaultValue `{ concurrency: 1 }`
   * @throws RangeError when `concurrency` is below one.
   */
  protected constructor(options: { readonly concurrency?: number } = {}) {
    const concurrency = options.concurrency ?? 1;
    if (!(concurrency >= 1)) throw new RangeError('an engine records at least one model at once');
    this.concurrency = concurrency;
  }

  /**
   * Record `model` for `input` into `recorder`, in turn: `input` is checked at once, and this
   * resolves once the recording is complete, or rejects with why it failed or stopped. A model's
   * `record` calls it with the recorder of the recording it returns; a transport calls it with a
   * recorder that forwards.
   *
   * @throws TypeError or RangeError for an input the engine refuses, before anything is recorded.
   */
  record(model: Model, input: unknown, recorder: Engine.Recorder): Promise<void> {
    const parsed = this.parse(input);
    const { signal } = recorder;
    return new Promise<void>((resolve, reject) => {
      const start = (): void => {
        this.#running++;
        recorder.start();
        let running: Promise<void>;
        try {
          running = this.execute(model, parsed, recorder);
        } catch (error) {
          running = Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        void running.then(resolve, reject).finally(() => {
          this.#running--;
          this.#next();
        });
      };
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      if (this.#running < this.concurrency) {
        start();
        return;
      }
      const leave = (): void => {
        const at = this.#waiting.indexOf(waiting);
        if (at < 0) return;
        this.#waiting.splice(at, 1);
        this.#tell();
        reject(abortReason(signal));
      };
      const waiting: Waiting = {
        recorder,
        start: () => {
          signal.removeEventListener('abort', leave);
          start();
        },
        leave,
      };
      signal.addEventListener('abort', leave, { once: true });
      this.#waiting.push(waiting);
      this.#tell();
    });
  }

  /**
   * An input as this engine takes it, from a host or a peer: checked, and the engine's own.
   *
   * @throws TypeError or RangeError naming what is wrong.
   */
  protected abstract parse(input: unknown): unknown;

  /**
   * Record `model` for an input `parse` returned: declare what the recording spans, append frames
   * as they are computed, and log along the way; resolve once it is complete. Throwing fails the
   * recording; `recorder.signal` aborts when its host stops it.
   */
  protected abstract execute(
    model: Model,
    input: unknown,
    recorder: Engine.Recorder,
  ): Promise<void>;

  /** Start the next recording waiting, if a turn is free. */
  #next(): void {
    if (this.#running >= this.concurrency) return;
    const waiting = this.#waiting.shift();
    if (!waiting) return;
    this.#tell();
    waiting.start();
  }

  /** Tell every waiting recording how many wait before it. */
  #tell(): void {
    this.#waiting.forEach((waiting, ahead) => waiting.recorder.wait(ahead));
  }
}

/** What an engine writes through. */
export declare namespace Engine {
  /**
   * A recording as its engine writes it. Every call before the engine resolves is in order; once
   * it ends, an append throws and the rest do nothing.
   */
  interface Recorder {
    /** Aborts when its host stops the recording. */
    readonly signal: AbortSignal;
    /**
     * Resolves once the recording can take more frames: await it between appends to go at the
     * pace of whoever reads them, such as a port. A recording in memory is always ready.
     */
    readonly ready: Promise<void>;
    /**
     * What the recording spans and the frames it expects, as soon as the engine knows; a later
     * call replaces what it gives.
     *
     * @throws RangeError or TypeError for a bad span or frame count.
     */
    declare(extent: {
      readonly span?: Domain | null;
      readonly expectedFrames?: number | null;
    }): void;
    /** It waits behind `ahead` others: its engine's queue, or the one its engine reports. */
    wait(ahead: number): void;
    /** It is computing. */
    start(): void;
    /**
     * Commit frames for every recorded class at once: `values[classId]` holds that class's
     * recorded signals frame-major, `(frame * signals + signal) * elements + element`, in the
     * order the class declares them; a class left out reads NaN over them. The recorder takes the
     * buffers: never touch them again.
     *
     * @throws TypeError or RangeError when the frames are invalid, and nothing changes; Error once
     * the recording has ended.
     */
    append(time: Float64Array, values: Readonly<Record<string, Float32Array | Float64Array>>): void;
    /** A line for the recording's log. */
    log(level: 'info' | 'warn' | 'error', message: string): void;
  }
}

/** Why `signal` aborted, as an error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The recording was stopped.', 'AbortError');
}
