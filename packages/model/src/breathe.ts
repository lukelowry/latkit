/** The scheduler yield a browser may offer; a task-queue hop otherwise. */
interface Yielding {
  yield?(): Promise<void>;
}

/** Concurrent callers share the next fallback task; no resources remain once it finishes. */
let pending: Promise<void> | null = null;

/**
 * Yield to the event loop, not just the microtask queue, so input and rendering stay responsive;
 * unlike a chain of `setTimeout(0)`, never clamped to 4 ms.
 */
export function breathe(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: Yielding }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  pending ??= new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      pending = null;
      resolve();
    };
    channel.port2.postMessage(null);
  });
  return pending;
}
