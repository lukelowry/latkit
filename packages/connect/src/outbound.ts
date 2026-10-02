import { deferred, errorOf } from './core.js';
import type { Socket } from './socket.js';

interface Write {
  readonly bytes: number;
  readonly encode: () => Uint8Array;
  readonly done: ReturnType<typeof deferred<void>>;
}

/** One FIFO writer. Callers retain admission until their final write completes:
 * one publication per sender, one ACK per receiver, and bounded lifecycle/telemetry controls.
 * Queue size depends on admitted streams, never publication count or stall duration.
 */
export class Outbound {
  readonly #queue = new Set<Write>();
  #running = false;
  constructor(
    private readonly socket: Socket,
    private readonly signal: AbortSignal,
    private readonly failed: (error: Error) => void,
  ) {
    signal.addEventListener('abort', () => this.reject(errorOf(signal.reason)), { once: true });
  }
  write(bytes: number, encode: () => Uint8Array): Promise<void> {
    this.signal.throwIfAborted();
    const done = deferred<void>();
    this.#queue.add({ bytes, encode, done });
    if (!this.#running) {
      this.#running = true;
      void this.drain();
    }
    return done.promise;
  }
  private async drain(): Promise<void> {
    try {
      for (const item of this.#queue) {
        await this.socket.waitForCapacity(item.bytes, this.signal);
        // ACK state is read after waiting, immediately before the synchronous send.
        this.socket.send(item.encode());
        this.#queue.delete(item);
        item.done.resolve();
      }
    } catch (cause) {
      const error = errorOf(cause);
      this.reject(error);
      if (!this.signal.aborted) this.failed(error);
    } finally {
      this.#running = false;
    }
  }
  private reject(error: Error): void {
    for (const item of this.#queue) item.done.reject(error);
    this.#queue.clear();
  }
}
