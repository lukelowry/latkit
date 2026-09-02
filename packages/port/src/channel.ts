/**
 * Request, reply, and stream over a port, multiplexed by protocol name: ids, cancellation,
 * progress, server events, and one close in each direction. `serve` answers; `connect` calls.
 * Payloads are JSON values plus typed arrays; a handler that hands buffers over marks its reply
 * `transferred`.
 */

import { describeError } from './error.js';
import type { Port } from './port.js';
import type { Progress, Protocol } from './protocol.js';

/** A reply, or one streamed item, whose buffers the handler relinquishes to the transport. */
export class Transferred<T> {
  /** Wrap `value`, naming the buffers in it the transport may detach. */
  constructor(
    readonly value: T,
    readonly transfer: readonly ArrayBuffer[],
  ) {}
}

/** Mark a reply's buffers as relinquished. */
export function transferred<T>(value: T, transfer: readonly ArrayBuffer[]): Transferred<T> {
  return new Transferred(value, transfer);
}

type Envelope =
  | { readonly svc: string; readonly kind: 'call'; readonly id: number; readonly body: unknown }
  | { readonly svc: string; readonly kind: 'yield'; readonly id: number; readonly body: unknown }
  | { readonly svc: string; readonly kind: 'reply'; readonly id: number; readonly body?: unknown }
  | { readonly svc: string; readonly kind: 'error'; readonly id: number; readonly message: string }
  | {
      readonly svc: string;
      readonly kind: 'progress';
      readonly id: number;
      readonly loaded: number;
      readonly total: number;
    }
  | { readonly svc: string; readonly kind: 'cancel'; readonly id: number }
  | { readonly svc: string; readonly kind: 'event'; readonly body: unknown }
  | { readonly svc: string; readonly kind: 'close'; readonly reason: string };

/** The envelope addressed to `name`, or null for anything else or anything malformed. */
function envelopeFor(name: string, message: unknown): Envelope | null {
  if (typeof message !== 'object' || message === null) return null;
  const candidate = message as Record<string, unknown>;
  if (candidate.svc !== name) return null;
  const addressed = typeof candidate.id === 'number';
  switch (candidate.kind) {
    case 'call':
    case 'yield':
    case 'reply':
    case 'cancel':
      return addressed ? (message as Envelope) : null;
    case 'error':
      return addressed && typeof candidate.message === 'string' ? (message as Envelope) : null;
    case 'progress':
      return addressed &&
        typeof candidate.loaded === 'number' &&
        typeof candidate.total === 'number'
        ? (message as Envelope)
        : null;
    case 'event':
      return message as Envelope;
    case 'close':
      return typeof candidate.reason === 'string' ? (message as Envelope) : null;
    default:
      return null;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Answers one call. A returned promise is the one reply; a returned async iterable is a stream,
 * one `yield` per item. `signal` aborts when the caller cancels or the service closes.
 */
export type Handler<Req, Res> = (
  request: Req,
  signal: AbortSignal,
  progress: Progress,
) => Promise<Res | Transferred<Res>> | AsyncIterable<Res | Transferred<Res>>;

/** A served side: push events to the peer, or stop. */
export interface Service<Ev> {
  emit(event: Ev): void;
  close(): void;
}

/**
 * Answer one peer's calls to `protocol` until either side closes.
 *
 * @remarks
 * When the protocol carries a guard, a request it refuses is answered with an error and never
 * reaches the handler. Between the items of a stream the service awaits the port's `drain`, so
 * backpressure reaches the producer without any help from the handler.
 */
export function serve<Req, Res, Ev = never>(
  port: Port,
  protocol: Protocol<Req, Res, Ev>,
  handle: Handler<Req, Res>,
  options: { readonly onClose?: () => void } = {},
): Service<Ev> {
  const { name, guard } = protocol;
  const inflight = new Map<number, AbortController>();
  let open = true;
  const post = (envelope: Envelope, transfer?: readonly ArrayBuffer[]): void =>
    port.post(envelope, transfer);
  const item = (kind: 'yield' | 'reply', id: number, value: unknown): void => {
    if (value instanceof Transferred)
      post({ svc: name, kind, id, body: value.value }, value.transfer);
    else post({ svc: name, kind, id, body: value });
  };

  function end(reason: string, notify: boolean): void {
    if (!open) return;
    open = false;
    unsubscribe();
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    if (notify) post({ svc: name, kind: 'close', reason });
    options.onClose?.();
  }

  async function answer(id: number, body: unknown, signal: AbortSignal): Promise<void> {
    if (guard && !guard(body)) throw new Error(`malformed ${name} request`);
    const progress: Progress = (loaded, total) => {
      if (!signal.aborted) post({ svc: name, kind: 'progress', id, loaded, total });
    };
    const result = handle(body as Req, signal, progress);
    if (!isAsyncIterable(result)) {
      const value = await result;
      if (!signal.aborted) item('reply', id, value);
      return;
    }
    for await (const value of result) {
      if (signal.aborted) return;
      item('yield', id, value);
      await port.drain?.();
    }
    if (!signal.aborted) post({ svc: name, kind: 'reply', id });
  }

  const unsubscribe = port.subscribe(
    (message) => {
      const envelope = envelopeFor(name, message);
      if (!envelope) return;
      if (envelope.kind === 'close') {
        end(envelope.reason, false);
        return;
      }
      if (envelope.kind === 'cancel') {
        inflight.get(envelope.id)?.abort();
        return;
      }
      if (envelope.kind !== 'call') return;
      const { id } = envelope;
      const controller = new AbortController();
      inflight.set(id, controller);
      void answer(id, envelope.body, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            post({ svc: name, kind: 'error', id, message: describeError(error) });
          }
        })
        .finally(() => inflight.delete(id));
    },
    (reason) => end(reason, false),
  );

  return {
    emit: (event) => {
      if (open) post({ svc: name, kind: 'event', body: event });
    },
    close: () => end('The service was closed.', true),
  };
}

/** Per-call knobs: cancellation, progress, and buffers the caller relinquishes. */
export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly progress?: Progress;
  readonly transfer?: readonly ArrayBuffer[];
}

/** A connected side: call the peer, stream from it, listen to its events, or stop. */
export interface Connection<Req, Res, Ev = never> {
  /**
   * Send one request and await its one reply. Rejects with `AbortError` when `signal` aborts, and
   * with an error when the handler streams instead of replying.
   */
  call(request: Req, options?: CallOptions): Promise<Res>;
  /**
   * Send one request and iterate what the handler yields. The iteration ends quietly when `signal`
   * aborts or the loop exits early, cancelling the handler either way; a handler failure ends it
   * with that error. A single-reply handler yields its one reply. Iterate once.
   */
  stream(request: Req, options?: CallOptions): AsyncIterable<Res>;
  on(listener: (event: Ev) => void): () => void;
  /** The reason once either side has closed; calls then reject with it. */
  readonly closed: string | null;
  close(): void;
}

/** What one call does with what comes back. */
interface Sink {
  item(body: unknown): void;
  done(body: unknown): void;
  fail(error: Error): void;
  abort(): void;
}

interface Pending extends Sink {
  readonly progress?: Progress;
  cleanup(): void;
}

/** One counter per realm, so two connections on one port never share an id. */
let nextId = 1;

/**
 * Call `protocol` on a peer that `serve`s it.
 *
 * @remarks
 * Nothing answers for a protocol no peer serves: such a call settles only when the transport
 * closes. Importing one protocol value at both ends is what keeps a name from ever differing.
 */
export function connect<Req, Res, Ev = never>(
  port: Port,
  protocol: Protocol<Req, Res, Ev>,
): Connection<Req, Res, Ev> {
  const { name } = protocol;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: Ev) => void>();
  let closed: string | null = null;
  const post = (envelope: Envelope, transfer?: readonly ArrayBuffer[]): void =>
    port.post(envelope, transfer);

  function take(id: number): Pending | undefined {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.cleanup();
    }
    return entry;
  }

  function end(reason: string): void {
    if (closed !== null) return;
    closed = reason;
    unsubscribe();
    for (const id of [...pending.keys()]) take(id)?.fail(new Error(reason));
    listeners.clear();
  }

  /** Register a call and send it; `sink` receives what comes back. */
  function open(id: number, request: Req, options: CallOptions, sink: Sink): void {
    const { signal } = options;
    const onAbort = (): void => {
      const entry = take(id);
      if (!entry) return;
      post({ svc: name, kind: 'cancel', id });
      entry.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      ...sink,
      progress: options.progress,
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    });
    post({ svc: name, kind: 'call', id, body: request }, options.transfer);
  }

  const unsubscribe = port.subscribe(
    (message) => {
      const envelope = envelopeFor(name, message);
      if (!envelope) return;
      switch (envelope.kind) {
        case 'yield':
          pending.get(envelope.id)?.item(envelope.body);
          return;
        case 'reply':
          take(envelope.id)?.done(envelope.body);
          return;
        case 'error':
          take(envelope.id)?.fail(new Error(envelope.message));
          return;
        case 'progress':
          pending.get(envelope.id)?.progress?.(envelope.loaded, envelope.total);
          return;
        case 'event':
          for (const listener of listeners) listener(envelope.body as Ev);
          return;
        case 'close':
          end(envelope.reason);
          return;
        default:
          return;
      }
    },
    (reason) => end(reason),
  );

  return {
    get closed() {
      return closed;
    },
    call(request, options = {}) {
      if (closed !== null) return Promise.reject(new Error(closed));
      if (options.signal?.aborted) return Promise.reject(abortError());
      const id = nextId++;
      return new Promise<Res>((resolve, reject) => {
        open(id, request, options, {
          item: () => {
            take(id);
            post({ svc: name, kind: 'cancel', id });
            reject(new Error(`${name} streams this request; use stream()`));
          },
          done: (body) => resolve(body as Res),
          fail: reject,
          abort: () => reject(abortError()),
        });
      });
    },
    stream(request, options = {}) {
      const { signal } = options;
      const queue: unknown[] = [];
      let outcome: { readonly error?: Error } | null = null;
      let wake: (() => void) | null = null;
      let id: number | null = null;
      const notify = (): void => {
        const resume = wake;
        wake = null;
        resume?.();
      };
      const begin = (): void => {
        if (id !== null) throw new Error('a stream iterates once');
        id = nextId++;
        if (closed !== null) {
          outcome = { error: new Error(closed) };
          return;
        }
        if (signal?.aborted) {
          outcome = {};
          return;
        }
        open(id, request, options, {
          item: (body) => {
            queue.push(body);
            notify();
          },
          done: (body) => {
            if (body !== undefined) queue.push(body);
            outcome = {};
            notify();
          },
          fail: (error) => {
            outcome = { error };
            notify();
          },
          abort: () => {
            outcome = {};
            notify();
          },
        });
      };
      return {
        async *[Symbol.asyncIterator]() {
          begin();
          try {
            for (;;) {
              if (queue.length > 0) {
                yield queue.shift() as Res;
                continue;
              }
              if (outcome) {
                if (outcome.error) throw outcome.error;
                return;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          } finally {
            if (id !== null && take(id)) post({ svc: name, kind: 'cancel', id });
          }
        },
      };
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed !== null) return;
      post({ svc: name, kind: 'close', reason: 'The connection was closed.' });
      end('The connection was closed.');
    },
  };
}
