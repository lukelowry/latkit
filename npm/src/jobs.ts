/**
 * The page's workers, doing views' jobs off the main thread. Each instantiates the module the page
 * compiled, so nothing is fetched again and nothing is shared but bytes.
 */

/** What a worker answers: the job's id, and its answer's bytes or why it failed. */
interface Answer {
  id: number;
  bytes?: Uint8Array;
  error?: string;
}

/** A pool of workers holding `module`, and the function that hands one a job's bytes. */
export function jobs(module: WebAssembly.Module): (bytes: Uint8Array) => Promise<Uint8Array> {
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const waiting = new Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>();
  let workers: Worker[] | undefined;
  let asked = 0;
  const pool = () =>
    (workers ??= Array.from({ length: size }, () => {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<Answer>) => {
        const job = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.bytes) job?.resolve(data.bytes);
        else job?.reject(new Error(data.error ?? 'a job failed'));
      };
      worker.postMessage(module);
      return worker;
    }));
  return (bytes) => {
    const id = asked++;
    const worker = pool()[id % size]!;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, bytes }, [bytes.buffer]);
    });
  };
}
