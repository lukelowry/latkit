import { failure, type FailureCode } from '@latkit/model';
import source from './worker.ts?worker';
import { runJob, type Job, type JobResults } from './jobs.js';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly job: Job;
  readonly transfer: readonly Transferable[];
}
interface Thread {
  readonly worker: Worker;
  readonly pending: Map<number, Pending>;
  /** Jobs waiting for the worker to start: their buffers stay here until it has. */
  readonly waiting: number[];
  ready: boolean;
}
type Reply = { ready?: true; id?: number; result?: unknown; error?: { code: string; message: string } };
/** At most this many workers: preparing and decoding run in parallel, up to the cores spared. */
const MAX_THREADS = 4;
let threads: Thread[] | null | undefined;
let serial = 0;
let url: string | undefined;

/** Run a job inline, on a later task, so a caller never runs it synchronously. */
function inline(job: Job): Promise<unknown> {
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(runJob(job).result);
      } catch (error) {
        reject(error);
      }
    }, 0),
  );
}
/** The workers, started once; null where the page cannot start them, which runs jobs inline. */
function pool(): Thread[] | null {
  if (threads !== undefined) return threads;
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined')
    return (threads = null);
  try {
    url ??= URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const count = Math.max(
      1,
      Math.min(MAX_THREADS, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
    );
    threads = [];
    for (let i = 0; i < count; i++) threads.push(start());
  } catch {
    threads = null;
  }
  return threads;
}
function start(): Thread {
  const worker = new Worker(url!, { name: 'latkit geography' }),
    thread: Thread = { worker, pending: new Map(), waiting: [], ready: false };
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const { ready, id, result, error } = event.data;
    if (ready) {
      thread.ready = true;
      for (const waiting of thread.waiting.splice(0)) post(thread, waiting);
      return;
    }
    const pending = thread.pending.get(id!);
    if (!pending) return;
    thread.pending.delete(id!);
    if (error) pending.reject(failure(error.code as FailureCode, error.message));
    else pending.resolve(result);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    // A worker refused by a content security policy without `worker-src blob:`, or one that dies:
    // jobs not yet sent, and every later one, run inline.
    const all = threads ?? [];
    threads = null;
    for (const t of all) {
      t.worker.terminate();
      for (const [id, pending] of t.pending)
        if (t.waiting.includes(id)) inline(pending.job).then(pending.resolve, pending.reject);
        else pending.reject(failure('unavailable', 'The geography worker stopped'));
    }
  };
  return thread;
}
function post(thread: Thread, id: number): void {
  const pending = thread.pending.get(id);
  if (pending) thread.worker.postMessage({ id, job: pending.job }, pending.transfer as Transferable[]);
}

/**
 * Run a job in a worker, transferring `transfer` to it; inline where workers cannot start. An
 * aborted signal rejects at once, and the worker's result is dropped.
 */
export function run<K extends Job['kind']>(
  job: Job & { kind: K },
  transfer: readonly Transferable[] = [],
  signal?: AbortSignal,
): Promise<JobResults[K]> {
  signal?.throwIfAborted();
  const workers = pool();
  const done = workers
    ? new Promise<JobResults[K]>((resolve, reject) => {
        let thread = workers[0];
        for (const t of workers) if (t.pending.size < thread.pending.size) thread = t;
        const id = ++serial;
        thread.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, job, transfer });
        if (thread.ready) post(thread, id);
        else thread.waiting.push(id);
      })
    : (inline(job) as Promise<JobResults[K]>);
  if (!signal) return done;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    done.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
