/**
 * The pool of workers that run latkit's jobs, started on demand. Each worker receives the compiled
 * module once and has its own WebAssembly memory.
 */

import { thrown, type LatkitError } from './internal.js';

/** A worker's message: that it is ready, a job's bytes, or why it failed. */
interface Answer {
  ready?: boolean;
  bytes?: Uint8Array;
  error?: string;
}

interface Job {
  bytes: Uint8Array;
  resolve(bytes: Uint8Array): void;
  reject(error: LatkitError): void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
}

/** The error for a failed job: `cause` itself if it is one, else an `io` error saying it. */
function failure(cause: unknown): LatkitError {
  if (cause instanceof Error && 'code' in cause) return cause as LatkitError;
  const message = cause instanceof Error ? cause.message : String(cause);
  return thrown({ code: 'io', message, cause: cause instanceof Error ? cause : undefined });
}

/**
 * Returns the function latkit hands its jobs to. It runs each job on a pooled worker, one job per
 * worker at a time. latkit queues jobs itself and hands one over only when it can run, so the pool
 * grows only to the number of jobs running at once, and nothing queues here. Idle workers are
 * terminated after 30 seconds. A job fails after one minute, including a new worker's startup. A
 * failure rejects that job and terminates its worker; later jobs start a new one.
 */
export function jobs(
  module: WebAssembly.Module,
  worker = () => new Worker(new URL('./worker.js', import.meta.url)),
): (bytes: Uint8Array) => Promise<Uint8Array> {
  const idle = new Set<Slot>();

  const retire = (slot: Slot): void => {
    clearTimeout(slot.timer);
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.onmessageerror = null;
    slot.worker.terminate();
    idle.delete(slot);
  };

  const fail = (slot: Slot, cause: unknown): void => {
    const job = slot.job;
    retire(slot);
    job?.reject(failure(cause));
  };

  const send = (slot: Slot): void => {
    const job = slot.job;
    if (!job || !slot.ready) return;
    try {
      slot.worker.postMessage(job.bytes, [job.bytes.buffer]);
    } catch (error) {
      fail(slot, error);
    }
  };

  const start = (): Slot => {
    const slot: Slot = { worker: worker(), ready: false };
    slot.worker.onmessage = ({ data }: MessageEvent<Answer>) => {
      if (!slot.ready) {
        if (!data.ready) return fail(slot, data.error ?? 'worker initialization failed');
        slot.ready = true;
        send(slot);
      } else if (slot.job) {
        if (!(data.bytes instanceof Uint8Array))
          return fail(slot, data.error ?? 'invalid worker answer');
        const job = slot.job;
        slot.job = undefined;
        clearTimeout(slot.timer);
        slot.timer = setTimeout(() => retire(slot), 30_000);
        idle.add(slot);
        job.resolve(data.bytes);
      }
    };
    slot.worker.onerror = (event) => {
      event.preventDefault();
      fail(slot, event.message || 'worker failed');
    };
    slot.worker.onmessageerror = () => fail(slot, 'could not read worker message');
    return slot;
  };

  return (bytes) =>
    new Promise((resolve, reject) => {
      const job = { bytes, resolve, reject };
      let slot = idle.values().next().value;
      try {
        if (slot) idle.delete(slot);
        else {
          slot = start();
          slot.worker.postMessage(module);
        }
        clearTimeout(slot.timer);
        slot.job = job;
        const active = slot;
        const timedOut = () => thrown({ code: 'timeout', message: 'a worker job timed out' });
        slot.timer = setTimeout(() => fail(active, timedOut()), 60_000);
        send(slot);
      } catch (error) {
        if (slot) retire(slot);
        reject(failure(error));
      }
    });
}
