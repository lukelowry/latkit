/**
 * The page's workers, doing views' jobs off the main thread. Each instantiates the module the page
 * compiled, so nothing is fetched again and nothing is shared but bytes.
 */

/** What a worker answers: a job's answer's bytes, or why it failed. */
interface Answer {
  bytes?: Uint8Array;
  error?: string;
}

/** A job no worker has taken yet. */
interface Job {
  bytes: Uint8Array;
  resolve(bytes: Uint8Array): void;
  reject(error: Error): void;
}

/**
 * A pool of workers holding `module`, and the function that hands one a job's bytes. Each worker
 * takes one job at a time, the oldest waiting, so a long job never holds up the ones behind it. A
 * worker whose job failed is replaced: a failure may have left its instance unusable.
 */
export function jobs(module: WebAssembly.Module): (bytes: Uint8Array) => Promise<Uint8Array> {
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const queue: Job[] = [];
  const idle: Worker[] = [];
  let started = 0;
  const start = (): Worker => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.postMessage(module);
    return worker;
  };
  const next = (worker: Worker): void => {
    const job = queue.shift();
    if (!job) return void idle.push(worker);
    const failed = (error: string) => {
      job.reject(new Error(error));
      worker.terminate();
      next(start());
    };
    worker.onmessage = ({ data }: MessageEvent<Answer>) => {
      if (!data.bytes) return failed(data.error ?? 'a job failed');
      job.resolve(data.bytes);
      next(worker);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      failed(event.message || 'a worker failed');
    };
    worker.postMessage(job.bytes, [job.bytes.buffer]);
  };
  return (bytes) =>
    new Promise((resolve, reject) => {
      queue.push({ bytes, resolve, reject });
      const worker = idle.pop() ?? (started < size ? (started++, start()) : undefined);
      if (worker) next(worker);
    });
}
