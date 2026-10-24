/** Shared on-demand workers. Each receives the compiled module once and owns its WASM memory. */
interface Answer {
  ready?: boolean;
  bytes?: Uint8Array;
  error?: string;
}

interface Job {
  bytes: Uint8Array;
  resolve(bytes: Uint8Array): void;
  reject(error: Error): void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps the workers that do latkit's jobs alive, one job each. latkit queues its jobs and hands one
 * over only when it can run, so the pool grows to as many jobs as run at once and nothing waits here.
 * Idle workers retire after 30 seconds; startup and jobs have a one-minute deadline. Failure rejects
 * the affected job and retires the worker; later jobs get a fresh one.
 */
export function jobs(
  module: WebAssembly.Module,
  createWorker = () => new Worker(new URL('./worker.js', import.meta.url)),
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
    job?.reject(cause instanceof Error ? cause : new Error(String(cause)));
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
    const worker = createWorker();
    const slot: Slot = { worker, ready: false };
    worker.onmessage = ({ data }: MessageEvent<Answer>) => {
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
    worker.onerror = (event) => {
      event.preventDefault();
      fail(slot, event.message || 'worker failed');
    };
    worker.onmessageerror = () => fail(slot, 'could not read worker message');
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
        slot.timer = setTimeout(() => fail(active, 'worker job timed out'), 60_000);
        send(slot);
      } catch (error) {
        if (slot) retire(slot);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
}
