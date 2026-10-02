import { deferred, errorOf, failure, interrupt } from './core.js';
import { subprotocol } from './frame.js';
import type { Limits, WebSocketLike } from './types.js';

/** Synchronous binary receive dispatch. All application queues live in Session. */
export class Socket {
  readonly ready = deferred<void>();
  #stopped = false;
  readonly #message = (event: { data: unknown }) => {
    if (this.#stopped) return;
    try {
      if (
        !(event.data instanceof ArrayBuffer) ||
        event.data.byteLength > this.bounds.maxMessageBytes
      )
        throw failure('protocol', 'Expected a bounded binary message.');
      this.receive(new Uint8Array(event.data));
    } catch (error) {
      this.ended(errorOf(error));
    }
  };
  readonly #open = () => {
    if (this.peer.protocol !== subprotocol) {
      const error = failure('protocol', 'The peer must negotiate the latkit subprotocol.');
      this.ready.reject(error);
      this.ended(error);
    } else this.ready.resolve();
  };
  readonly #end = () => {
    const error = failure('disconnected', 'The model socket closed.');
    this.ready.reject(error);
    if (!this.#stopped) this.ended(error);
  };
  constructor(
    private readonly peer: WebSocketLike,
    private readonly getBounds: () => Limits,
    private readonly receive: (bytes: Uint8Array) => void,
    private readonly ended: (error: Error) => void,
  ) {
    peer.binaryType = 'arraybuffer';
    peer.addEventListener('message', this.#message);
    peer.addEventListener('open', this.#open);
    peer.addEventListener('error', this.#end);
    peer.addEventListener('close', this.#end);
    if (peer.readyState === 1) queueMicrotask(this.#open);
    else if (peer.readyState > 1) queueMicrotask(this.#end);
  }
  private get bounds(): Limits {
    return this.getBounds();
  }
  async waitForCapacity(bytes: number, signal: AbortSignal): Promise<void> {
    // Called only by the session's single writer: one poller and no competing reservations.
    for (;;) {
      signal.throwIfAborted();
      if (this.#stopped || this.peer.readyState !== 1)
        throw failure('closed', 'The socket is closed.');
      if (this.peer.bufferedAmount + bytes <= this.bounds.maxBufferedBytes) return;
      await interrupt(new Promise<void>((resolve) => setTimeout(resolve, 4)), signal);
    }
  }
  send(bytes: Uint8Array): void {
    if (this.#stopped || this.peer.readyState !== 1)
      throw failure('closed', 'The socket is closed.');
    // Browser/Node native send copies; ws may borrow. Encoded frames are never mutated.
    this.peer.send(bytes as Uint8Array<ArrayBuffer>);
  }
  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.ready.reject(failure('closed', 'The session closed.'));
    this.peer.removeEventListener('message', this.#message);
    this.peer.removeEventListener('open', this.#open);
    // Remove the close/error listeners once native teardown finishes.
    const cleanup = () => {
      this.peer.removeEventListener('error', this.#end);
      this.peer.removeEventListener('close', this.#end);
      this.peer.removeEventListener('close', cleanup);
    };
    if (this.peer.readyState === 3) cleanup();
    else {
      this.peer.addEventListener('close', cleanup);
      this.peer.close(1000);
    }
  }
}
