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
 * Runs one job per worker. Idle workers retire after 30 seconds; startup and jobs have a one-minute
 * deadline. Failure rejects the affected job and retires the worker; later jobs get a fresh one.
 */
export function jobs(
  module: WebAssembly.Module,
  createWorker = () => new Worker(new URL('./worker.js', import.meta.url)),
): (bytes: Uint8Array) => Promise<Uint8Array> {
  const size = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
  const queue: Job[] = [];
  const slots = new Set<Slot>();

  const retire = (slot: Slot): void => {
    clearTimeout(slot.timer);
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.onmessageerror = null;
    slot.worker.terminate();
    slots.delete(slot);
  };

  const fail = (slot: Slot, cause: unknown): void => {
    const job = slot.job;
    retire(slot);
    job?.reject(cause instanceof Error ? cause : new Error(String(cause)));
    pump();
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
    slots.add(slot);
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
        job.resolve(data.bytes);
        pump();
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(slot, event.message || 'worker failed');
    };
    worker.onmessageerror = () => fail(slot, 'could not read worker message');
    return slot;
  };

  function pump(): void {
    while (queue.length) {
      let slot = [...slots].find((candidate) => !candidate.job);
      if (!slot && slots.size >= size) return;
      const job = queue.shift()!;
      try {
        slot ??= start();
        clearTimeout(slot.timer);
        slot.job = job;
        const active = slot;
        slot.timer = setTimeout(() => fail(active, 'worker job timed out'), 60_000);
        if (slot.ready) send(slot);
        else slot.worker.postMessage(module);
      } catch (error) {
        if (slot) retire(slot);
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return (bytes) =>
    new Promise((resolve, reject) => {
      queue.push({ bytes, resolve, reject });
      pump();
    });
}
