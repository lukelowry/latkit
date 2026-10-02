import type { Transport } from '../transport.js';
import type { ConnectOptions } from '../connection.js';
import { backing, inspect, limits, transferable } from './frame.js';
import { limitTransport } from './transport-limits.js';
import type { Limits } from './frame.js';
import {
  aborted,
  decodeError,
  deferred,
  encodeError,
  errorValue,
  failure,
  interrupt,
} from './errors.js';
import type { Deferred } from './errors.js';
export interface Reply {
  value: unknown;
  owned?: boolean;
  discard?: () => Promise<void>;
}
interface Pending extends Deferred<unknown> {
  cleanup: () => void;
  credit: number;
}
/** Single-item pull credits: no unsolicited stream items and no receive-side data queues. */
export class Peer {
  bounds: Limits;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  invoke?: (
    ref: number,
    method: string,
    args: unknown,
    signal: AbortSignal,
    credit: number,
  ) => Promise<Reply>;
  event?: (ref: number, event: string, state: unknown, value: unknown) => void;
  orphan?: (value: unknown) => void;
  dispose?: () => Promise<void>;
  private readonly handshake = deferred<void>();
  private readonly finished = deferred<void>();
  private readonly pending = new Map<number, Pending>();
  private readonly active = new Map<number, AbortController>();
  private readonly waiters = new Set<() => void>();
  private readonly calls = new Set<Promise<void>>();
  private nextId = 1;
  private usedBytes = 0;
  private queuedBytes = 0;
  private ended = false;
  private welcomed = false;
  private unsubscribe: () => void = () => undefined;
  private removeAbort: () => void = () => undefined;
  private cleanup: Promise<void> | undefined;
  constructor(
    readonly transport: Transport,
    options: Omit<ConnectOptions, 'kind'>,
  ) {
    this.bounds = limits(options.limits);
    limitTransport(transport, this.bounds);
    this.ready = this.handshake.promise;
    this.closed = this.finished.promise;
    this.unsubscribe = transport.subscribe(
      (message) => {
        try {
          this.receive(message);
        } catch (error) {
          this.end(errorValue(error));
        }
      },
      (error) => this.end(error ?? failure('disconnected', 'Transport ended.')),
    );
    const abort = (): void => this.end(failure('aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    this.removeAbort = () => options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) abort();
    else
      queueMicrotask(() => {
        void this.send({ kind: 'hello', version: 4, limits: this.bounds }).catch((error) =>
          this.end(errorValue(error)),
        );
      });
  }
  get blockBytes(): number {
    return Math.max(
      1,
      Math.floor(this.bounds.maxInFlightBytes / 2) -
        Math.min(this.bounds.maxMetadataBytes, Math.floor(this.bounds.maxInFlightBytes / 4)) -
        1024,
    );
  }
  get itemBytes(): number {
    return this.bounds.maxInFlightBytes;
  }
  check(): void {
    if (this.ended) throw failure('disconnected', 'Connection is closed.');
  }
  async reserve(bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (bytes < 0 || bytes > this.bounds.maxInFlightBytes) throw failure('resource-limit');
    while (true) {
      this.check();
      aborted(signal);
      if (this.usedBytes + bytes <= this.bounds.maxInFlightBytes) {
        this.usedBytes += bytes;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.usedBytes -= bytes;
          for (const wake of this.waiters) wake();
        };
      }
      const wake = deferred<void>();
      const notify = (): void => wake.resolve();
      this.waiters.add(notify);
      try {
        await interrupt(wake.promise, signal);
      } finally {
        this.waiters.delete(notify);
      }
    }
  }
  async call(
    ref: number,
    method: string,
    args: unknown,
    signal?: AbortSignal,
    credit = 0,
  ): Promise<unknown> {
    await interrupt(this.ready, signal);
    this.check();
    aborted(signal);
    if (this.pending.size >= this.bounds.maxReferences)
      throw failure('resource-limit', 'Too many pending requests.');
    const id = this.nextId++;
    const result = deferred<unknown>();
    const abort = (): void => {
      if (!this.pending.delete(id)) return;
      result.reject(failure('aborted'));
      void this.send({ kind: 'cancel', id }).catch((error) => this.end(errorValue(error)));
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.pending.set(id, {
      ...result,
      credit,
      cleanup: () => signal?.removeEventListener('abort', abort),
    });
    try {
      await interrupt(this.send({ kind: 'call', id, ref, method, args, credit }), signal);
      return await result.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.pending.delete(id);
    }
  }
  notify(ref: number, event: string, state: unknown, value?: unknown): void {
    if (this.ended) return;
    void this.send({ kind: 'event', ref, event, state, value }).catch((error) =>
      this.end(errorValue(error)),
    );
  }
  async send(message: unknown, owned = false): Promise<void> {
    this.check();
    const plan = inspect(message, this.bounds);
    // The adapter owns only a bounded queue. Slow event consumers fail rather than accumulate silently.
    if (this.queuedBytes + plan.bytes > this.bounds.maxInFlightBytes)
      throw failure('resource-limit', 'Outgoing queue is full.');
    this.queuedBytes += plan.bytes;
    try {
      if (this.transport.transfers) {
        const outgoing = owned
          ? { value: message, buffers: backing(message, this.bounds) }
          : transferable(message, this.bounds);
        await this.transport.send(outgoing.value, outgoing.buffers);
      } else await this.transport.send(message);
    } finally {
      this.queuedBytes -= plan.bytes;
    }
  }
  private receive(message: unknown): void {
    if (this.ended) return;
    const plan = inspect(message, this.bounds);
    if (!message || typeof message !== 'object' || Array.isArray(message))
      throw failure('invalid-input', 'Invalid envelope.');
    const m = message as Record<string, unknown>;
    if (m.kind === 'hello') {
      if (this.welcomed || m.version !== 4 || !m.limits || typeof m.limits !== 'object')
        throw failure('unsupported', 'Unsupported connect handshake.');
      const remote = limits(m.limits as Partial<Limits>);
      for (const key of Object.keys(this.bounds) as (keyof Limits)[])
        this.bounds[key] = Math.min(this.bounds[key], remote[key]);
      limitTransport(this.transport, this.bounds);
      this.welcomed = true;
      this.handshake.resolve();
      return;
    }
    if (!this.welcomed) throw failure('invalid-input', 'Missing handshake.');
    if (m.kind === 'close') {
      this.end();
      return;
    }
    if (m.kind === 'event') {
      if (!integer(m.ref) || typeof m.event !== 'string')
        throw failure('invalid-input', 'Invalid event.');
      this.event?.(m.ref, m.event, m.state, m.value);
      return;
    }
    if (!integer(m.id)) throw failure('invalid-input', 'Invalid request ID.');
    const id = m.id;
    if (m.kind === 'result' || m.kind === 'failure') {
      const pending = this.pending.get(id);
      if (!pending) {
        if (m.kind === 'result') this.orphan?.(m.value);
        return;
      }
      if (pending.credit && plan.bytes > pending.credit)
        throw failure('resource-limit', 'Reply exceeds pull credit.');
      this.pending.delete(id);
      pending.cleanup();
      if (m.kind === 'failure') pending.reject(decodeError(m.error));
      else pending.resolve(m.value);
      return;
    }
    if (m.kind === 'cancel') {
      this.active.get(id)?.abort();
      return;
    }
    if (
      m.kind !== 'call' ||
      !integer(m.ref) ||
      typeof m.method !== 'string' ||
      !integer(m.credit) ||
      m.credit > this.bounds.maxInFlightBytes
    )
      throw failure('invalid-input', 'Invalid call.');
    if (this.active.has(id) || this.active.size >= this.bounds.maxReferences)
      throw failure('resource-limit', 'Active request limit exceeded.');
    const controller = new AbortController();
    this.active.set(id, controller);
    const task = this.answer(id, m.ref, m.method, m.args, controller, m.credit);
    this.calls.add(task);
    void task.finally(() => this.calls.delete(task)).catch((error) => this.end(errorValue(error)));
  }
  private async answer(
    id: number,
    ref: number,
    method: string,
    args: unknown,
    controller: AbortController,
    credit: number,
  ): Promise<void> {
    let reply: Reply | undefined;
    try {
      if (!this.invoke) throw failure('closed');
      reply = await this.invoke(ref, method, args, controller.signal, credit);
      if (controller.signal.aborted || this.ended) {
        await reply.discard?.();
        return;
      }
      const message = { kind: 'result', id, value: reply.value };
      if (credit && inspect(message, this.bounds).bytes > credit)
        throw failure('resource-limit', 'Stream item exceeds pull credit.');
      await this.send(message, reply.owned);
    } catch (error) {
      await reply?.discard?.();
      if (!this.ended && !controller.signal.aborted)
        await this.send({ kind: 'failure', id, error: encodeError(error) });
    } finally {
      this.active.delete(id);
    }
  }
  private end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.unsubscribe();
    this.removeAbort();
    this.handshake.reject(error ?? failure('closed'));
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error ?? failure('disconnected'));
    }
    this.pending.clear();
    for (const controller of this.active.values()) controller.abort();
    for (const wake of this.waiters) wake();
    this.cleanup = (async () => {
      const closing = this.transport.close();
      await Promise.allSettled([closing, this.dispose?.(), ...this.calls]);
    })();
    void this.cleanup.then(
      () => (error ? this.finished.reject(error) : this.finished.resolve()),
      (error) => this.finished.reject(errorValue(error)),
    );
  }
  async close(): Promise<void> {
    if (!this.ended) {
      // Graceful when accepted immediately; a stalled send must never prevent local cleanup.
      void this.send({ kind: 'close' }).catch(() => undefined);
      this.end();
    }
    await this.cleanup;
  }
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
