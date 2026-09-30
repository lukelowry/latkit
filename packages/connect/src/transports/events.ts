import { errorValue, failure } from '../internal/errors.js';
/** Adapters may receive the handshake before connect/serve subscribes. Buffer only that message. */
export class Events {
  private listener?: { receive: (value: unknown) => void; ended: (error?: Error) => void };
  private terminal: Error | true | undefined;
  private initial: unknown[] = [];
  private started = false;
  subscribe(receive: (value: unknown) => void, ended: (error?: Error) => void): () => void {
    if (this.started) throw failure('conflict', 'Transport already subscribed.');
    this.started = true;
    const listener = { receive, ended };
    this.listener = listener;
    queueMicrotask(() => {
      if (this.listener !== listener) return;
      if (this.terminal !== undefined) ended(this.terminal === true ? undefined : this.terminal);
      else for (const value of this.initial.splice(0)) receive(value);
      this.initial = [];
    });
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }
  message(value: unknown): void {
    if (this.terminal !== undefined) return;
    if (this.listener && !this.initial.length) this.listener.receive(value);
    else if (!this.started || this.initial.length) {
      if (this.initial.length)
        this.end(failure('resource-limit', 'Unconsumed transport handshake.'));
      else this.initial.push(value);
    }
  }
  end(error?: unknown): void {
    if (this.terminal !== undefined) return;
    this.terminal = error === undefined ? true : errorValue(error);
    this.initial = [];
    this.listener?.ended(this.terminal === true ? undefined : this.terminal);
    this.listener = undefined;
  }
  check(): void {
    if (this.terminal !== undefined) throw failure('disconnected', 'Transport is closed.');
  }
}
