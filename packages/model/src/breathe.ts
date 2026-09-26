/** The scheduler yield a browser may offer; a task-queue hop otherwise. */
interface Yielding {
  yield?(): Promise<void>;
}

/** Waiters for the one shared message channel, resolved in posting order. */
let waiters: Array<() => void> = [];
let channel: MessageChannel | null = null;

/**
 * Yield to the event loop, not just the microtask queue, so input and rendering stay responsive;
 * unlike a chain of `setTimeout(0)`, never clamped to 4 ms.
 */
export function breathe(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: Yielding }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const pending = waiters;
        waiters = [];
        for (const wake of pending) wake();
      };
    }
    waiters.push(resolve);
    channel.port2.postMessage(null);
  });
}
