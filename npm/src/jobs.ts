/**
 * latkit's jobs: the work that scales with the data, such as layouts, triangles, and decoding. A
 * WebAssembly module of its own does it, loaded the first time there is a job, so the module that
 * draws carries none of that code. A pool of workers runs it, started on demand. Each worker
 * receives the compiled module once and has its own WebAssembly memory.
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

/** The error for a failed job: `cause` if it is a latkit error, else an `io` error from it. */
function failure(cause: unknown): LatkitError {
  if (cause instanceof Error && 'code' in cause) return cause as LatkitError;
  const message = cause instanceof Error ? cause.message : String(cause);
  return thrown({ code: 'io', message, cause: cause instanceof Error ? cause : undefined });
}

/**
 * Returns the jobs module compiled, from `source`: the module itself, or its URL. It is fetched
 * and compiled on the first call, and again on a call after one that failed with an `io` error.
 */
export function compiled(source: string | WebAssembly.Module): () => Promise<WebAssembly.Module> {
  let loading: Promise<WebAssembly.Module> | undefined;
  const compile = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    // A server that names another content type gets the bytes compiled once they are all here.
    const streams = response.headers.get('Content-Type')?.startsWith('application/wasm');
    return streams && typeof WebAssembly.compileStreaming === 'function'
      ? WebAssembly.compileStreaming(response)
      : WebAssembly.compile(await response.arrayBuffer());
  };
  return () =>
    (loading ??=
      typeof source === 'string'
        ? compile(source).catch((cause: unknown) => {
            loading = undefined;
            throw thrown({
              code: 'io',
              message: `could not load latkit's jobs from ${source}`,
              cause,
            });
          })
        : Promise.resolve(source));
}

/**
 * Returns the function latkit hands its jobs to, given `module`, which resolves to the compiled
 * jobs module. It runs each job on a pooled worker that `worker` creates, one job per worker at a
 * time. latkit queues jobs itself and hands one over only when it can run, so the pool grows only
 * to the number of jobs running at once and nothing queues here. Idle workers are terminated after
 * 30 seconds. A job times out after one minute, counting the module's load and a new worker's
 * startup. A failure rejects that job and terminates its worker. Later jobs start a new one.
 * Without `worker`, where a browser has no workers to start, each job runs on the calling thread.
 */
export function jobs(
  module: () => Promise<WebAssembly.Module>,
  worker?: () => Worker,
): (bytes: Uint8Array) => Promise<Uint8Array> {
  if (!worker) {
    let run: Promise<(bytes: Uint8Array) => Uint8Array> | undefined;
    return (bytes) => {
      run ??= Promise.all([import('../pkg/latkit_jobs.js'), module()]).then(
        ([bindings, loaded]) => {
          bindings.initSync({ module: loaded });
          return bindings.job;
        },
      );
      return run.then(
        (job) => job(bytes),
        (cause: unknown) => {
          run = undefined;
          throw failure(cause);
        },
      );
    };
  }
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
          // The worker starts while the module loads, and gets it as its first message.
          const started = (slot = start());
          module().then(
            (module) => {
              try {
                started.worker.postMessage(module);
              } catch (error) {
                fail(started, error);
              }
            },
            (cause: unknown) => fail(started, cause),
          );
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
