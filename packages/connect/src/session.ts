import { defaults, deferred, errorOf, failure, integer, interrupt, limits, text } from './core.js';
import { decode, Op, prepare } from './frame.js';
import type { Frame, Opcode, Plan } from './frame.js';
import { Socket } from './socket.js';
import { Outbound } from './outbound.js';
import type { Limits, WebSocketLike } from './types.js';

const ACK_BYTES = prepare(
  Op.ack,
  0xffffffff,
  { sequence: 0xffffffff, terminal: false },
  [],
  defaults,
).bytes;

export interface Delivery {
  readonly frame: Frame;
  release(): void;
}
export interface Terminal {
  readonly op: Opcode;
  readonly metadata: Record<string, unknown>;
}

/** One shared session for both endpoints. Buffers, request routing and cancellation live here. */
export class Session {
  readonly lifetime = new AbortController();
  readonly #done = deferred<void>();
  readonly closed = this.#done.promise;
  readonly socket: Socket;
  readonly outbound: Outbound;
  bounds: Limits;
  onControl: (frame: Frame) => void = () => {
    throw failure('protocol', 'Unexpected control message.');
  };
  readonly receivers = new Map<number, Receiver>();
  readonly senders = new Map<number, Sender>();
  #reservedBytes = 0;
  #reservedMessages = 0;
  #closing?: Promise<void>;
  #ended = false;
  #tasks = new Set<Promise<unknown>>();
  #cleanup?: Promise<void>;
  #external?: AbortSignal;
  readonly #abort = () => this.end();
  constructor(
    peer: WebSocketLike,
    options: { limits?: Partial<Limits>; signal?: AbortSignal } = {},
  ) {
    this.bounds = limits(options.limits);
    this.socket = new Socket(
      peer,
      () => this.bounds,
      (bytes) => this.receive(bytes),
      (error) => this.end(error),
    );
    this.outbound = new Outbound(this.socket, this.lifetime.signal, (error) => this.end(error));
    this.#external = options.signal;
    options.signal?.addEventListener('abort', this.#abort, { once: true });
    if (options.signal?.aborted) this.end();
  }
  track(task: Promise<unknown>): void {
    this.#tasks.add(task);
    void task.then(
      () => this.#tasks.delete(task),
      (error) => {
        this.#tasks.delete(task);
        this.end(errorOf(error));
      },
    );
  }
  async control(
    op: Opcode,
    id: number,
    metadata: Record<string, unknown> = {},
    chunks: readonly Uint8Array[] = [],
  ): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const plan = prepare(op, id, metadata, chunks, this.bounds);
    await this.outbound.write(plan.bytes, () => plan.encode());
  }

  receiver(id: number): Receiver {
    this.lifetime.signal.throwIfAborted();
    if (this.receivers.size >= this.bounds.maxStreams || this.receivers.has(id))
      throw failure('resource-limit', 'Too many observation streams.');
    const bytes = Math.min(
      this.bounds.streamWindowBytes,
      this.bounds.maxBufferedBytes - this.#reservedBytes,
    );
    const messages = Math.min(
      this.bounds.streamWindowMessages,
      this.bounds.maxBufferedMessages - this.#reservedMessages,
    );
    if (bytes < this.bounds.maxMessageBytes || messages < 1)
      throw failure('resource-limit', 'Receive windows exhaust the connection budget.');
    const stream = new Receiver(this, id, bytes, messages);
    this.#reservedBytes += bytes;
    this.#reservedMessages += messages;
    this.receivers.set(id, stream);
    return stream;
  }
  release(stream: Receiver): void {
    if (!this.receivers.delete(stream.id)) return;
    this.#reservedBytes -= stream.windowBytes;
    this.#reservedMessages -= stream.windowMessages;
  }
  sender(id: number, bytes: unknown, messages: unknown): Sender {
    if (this.senders.size >= this.bounds.maxStreams || this.senders.has(id))
      throw failure('resource-limit', 'Too many producer streams.');
    const reserved = [...this.senders.values()].reduce((sum, s) => sum + s.windowBytes, 0);
    if (reserved + integer(bytes, 1) > this.bounds.maxBufferedBytes)
      throw failure('resource-limit', 'Producer windows exhaust the connection budget.');
    const reservedMessages = [...this.senders.values()].reduce(
      (sum, s) => sum + s.windowMessages,
      0,
    );
    if (reservedMessages + integer(messages, 1) > this.bounds.maxBufferedMessages)
      throw failure('resource-limit', 'Producer message windows exhaust the connection budget.');
    const stream = new Sender(
      this,
      id,
      integer(bytes, this.bounds.maxMessageBytes, this.bounds.streamWindowBytes),
      integer(messages, 1, this.bounds.streamWindowMessages),
    );
    this.senders.set(id, stream);
    return stream;
  }
  private receive(bytes: Uint8Array): void {
    if (this.#ended) return;
    const frame = decode(bytes, this.bounds);
    if (frame.op === Op.publication) {
      const stream = this.receivers.get(frame.id);
      if (!stream) throw failure('protocol', 'Publication for an unknown stream.');
      stream.push(frame, bytes.byteLength);
      return;
    }
    if (frame.sequence !== 0) throw failure('protocol', 'Control sequence must be zero.');
    if (frame.op !== Op.run && frame.body.length)
      throw failure('protocol', 'Unexpected control body.');
    if (frame.op === Op.ack) {
      const stream = this.senders.get(frame.id);
      if (!stream) throw failure('protocol', 'Acknowledgement for an unknown stream.');
      stream.acknowledge(
        integer(frame.metadata.sequence, frame.metadata.terminal === true ? 0 : 1),
        frame.metadata.terminal === true,
      );
      return;
    }
    if (frame.op === Op.end || frame.op === Op.result || frame.op === Op.error) {
      const receiver = this.receivers.get(frame.id);
      if (receiver) {
        receiver.finish(frame);
        return;
      }
    }
    if (frame.op === Op.progress || frame.op === Op.log) {
      const receiver = this.receivers.get(frame.id);
      if (!receiver) throw failure('protocol', 'Telemetry for an unknown operation.');
      receiver.onTelemetry?.(frame);
      return;
    }
    if (frame.op === Op.cancel) {
      const sender = this.senders.get(frame.id);
      if (sender) sender.cancel();
      // A cancellation may cross the terminal acknowledgement. IDs are never reused.
      return;
    }
    if (frame.op === Op.close) {
      this.end(failure(text(frame.metadata.code, 128), text(frame.metadata.message, 4096)));
      return;
    }
    this.onControl(frame);
  }
  close(reason?: { code: string; message: string }): Promise<void> {
    return (this.#closing ??= this.shutdown(reason));
  }
  private async shutdown(reason?: { code: string; message: string }): Promise<void> {
    if (!this.#ended && reason) {
      try {
        await interrupt(
          this.control(Op.close, 0, reason),
          this.lifetime.signal,
          this.bounds.timeoutMs,
        );
      } catch {
        /* A best-effort reason must not prevent local teardown. */
      }
    }
    this.end();
    await this.#cleanup;
  }
  end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    const reason = error ?? failure('closed', 'The session closed.');
    this.#external?.removeEventListener('abort', this.#abort);
    this.lifetime.abort(reason);
    for (const receiver of this.receivers.values()) receiver.fail(reason);
    for (const sender of this.senders.values()) sender.cancel(reason);
    this.receivers.clear();
    this.senders.clear();
    this.socket.close();
    this.#cleanup = interrupt(
      Promise.allSettled([...this.#tasks]).then(() => undefined),
      new AbortController().signal,
      this.bounds.timeoutMs,
    );
    void this.#cleanup.then(
      () => {
        if (error) this.#done.reject(error);
        else this.#done.resolve();
      },
      (cause) => this.#done.reject(error ?? errorOf(cause)),
    );
  }
}

/** One consumer; one credit release per next() or completed onData callback. */
export class Receiver {
  readonly #stop = new AbortController();
  readonly signal: AbortSignal;
  #queue: (Delivery | undefined)[] = [];
  #head = 0;
  #held?: Delivery;
  #changed = deferred<void>();
  #terminal?: Terminal;
  #error?: Error;
  #cancelled = false;
  #pulling = false;
  #sequence = 0;
  #released = 0;
  #bytes = 0;
  #messages = 0;
  #ackRunning = false;
  readonly #retired = deferred<void>();
  #acknowledged = 0;
  #terminalAcknowledged = false;
  #timer?: ReturnType<typeof setTimeout>;
  onTelemetry?: (frame: Frame) => void;
  constructor(
    readonly session: Session,
    readonly id: number,
    readonly windowBytes: number,
    readonly windowMessages: number,
  ) {
    this.signal = AbortSignal.any([this.#stop.signal, session.lifetime.signal]);
  }
  get grant(): Record<string, number> {
    return { bytes: this.windowBytes, messages: this.windowMessages };
  }
  push(frame: Frame, bytes: number): void {
    if (this.#terminal || frame.sequence !== this.#sequence + 1)
      throw failure('protocol', 'Publication sequence is invalid.');
    this.#sequence = frame.sequence;
    this.#bytes += bytes;
    this.#messages++;
    if (this.#bytes > this.windowBytes || this.#messages > this.windowMessages)
      throw failure('resource-limit', 'The producer exceeded receive credit.');
    let released = false;
    const item: Delivery = {
      frame,
      release: () => {
        if (released) return;
        released = true;
        this.#bytes -= bytes;
        this.#messages--;
        this.#released = frame.sequence;
        this.acknowledge();
      },
    };
    if (this.#cancelled) item.release();
    else this.#queue.push(item);
    this.wake();
  }
  finish(frame: Frame): void {
    if (this.#terminal || frame.sequence) throw failure('protocol', 'Duplicate terminal message.');
    this.#terminal = { op: frame.op, metadata: frame.metadata };
    clearTimeout(this.#timer);
    this.acknowledge();
    this.wake();
  }
  fail(error: Error): void {
    this.#retired.reject(error);
    this.#stop.abort(error);
    this.#error = error;
    this.#cancelled = true;
    this.discard();
    clearTimeout(this.#timer);
    this.wake();
  }
  private wake(): void {
    this.#changed.resolve();
    this.#changed = deferred<void>();
  }
  private get needsAck(): boolean {
    return (
      !this.#terminalAcknowledged &&
      (this.#released > this.#acknowledged || Boolean(this.#terminal && this.#messages === 0))
    );
  }
  private acknowledge(): void {
    if (this.#ackRunning || !this.needsAck || this.session.lifetime.signal.aborted) return;
    this.#ackRunning = true;
    void this.flushAck();
  }
  private async flushAck(): Promise<void> {
    try {
      while (this.needsAck) {
        let sequence = 0,
          terminal = false;
        await this.session.outbound.write(ACK_BYTES, () => {
          sequence = this.#released;
          terminal = Boolean(this.#terminal && this.#messages === 0);
          return prepare(Op.ack, this.id, { sequence, terminal }, [], this.session.bounds).encode();
        });
        // Only a completed native send advances state. Later consumption gets the next turn.
        this.#acknowledged = sequence;
        this.#terminalAcknowledged = terminal;
        if (terminal) {
          this.session.release(this);
          this.#retired.resolve();
        }
      }
    } catch (error) {
      this.#retired.reject(error);
      if (!this.session.lifetime.signal.aborted) this.session.end(errorOf(error));
    } finally {
      this.#ackRunning = false;
    }
  }
  private discard(): void {
    this.#held?.release();
    this.#held = undefined;
    for (let i = this.#head; i < this.#queue.length; i++) this.#queue[i]?.release();
    this.#queue = [];
    this.#head = 0;
  }
  cancel(error: Error = failure('aborted', 'The operation was cancelled.')): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#stop.abort(error);
    this.#error = error;
    this.onTelemetry = undefined;
    this.discard();
    this.wake();
    if (this.#terminal) {
      this.acknowledge();
      return;
    }
    if (!this.session.lifetime.signal.aborted) {
      void this.session
        .control(Op.cancel, this.id)
        .then(() => {
          // Waiting for socket capacity is not evidence of an uncooperative producer.
          if (this.#terminal || this.session.lifetime.signal.aborted) return;
          this.#timer = setTimeout(
            () => this.session.end(failure('timeout', 'The producer did not finish cancellation.')),
            this.session.bounds.timeoutMs,
          );
        })
        .catch((cause) => this.session.end(errorOf(cause)));
    }
  }
  async next(): Promise<IteratorResult<Delivery, Terminal>> {
    if (this.#pulling) throw failure('busy', 'Concurrent pulls are unsupported.');
    this.#pulling = true;
    try {
      this.#held?.release();
      this.#held = undefined;
      for (;;) {
        if (this.#error) throw this.#error;
        if (this.#head < this.#queue.length) {
          const item = this.#queue[this.#head]!;
          this.#queue[this.#head++] = undefined;
          if (this.#head === this.#queue.length) {
            this.#queue = [];
            this.#head = 0;
          }
          if (this.#head > 128 && this.#head * 2 >= this.#queue.length) {
            this.#queue = this.#queue.slice(this.#head);
            this.#head = 0;
          }
          this.#held = item;
          return { done: false, value: item };
        }
        if (this.#terminal) {
          this.acknowledge();
          await interrupt(this.#retired.promise, this.signal);
          return { done: true, value: this.#terminal };
        }
        await this.#changed.promise;
      }
    } finally {
      this.#pulling = false;
    }
  }
}

/** Per-stream credits isolate slow consumers. Only size counters survive a send. */
export class Sender {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  #entries = new Map<number, number>();
  #sequence = 0;
  #acknowledged = 0;
  #bytes = 0;
  #changed = deferred<void>();
  #writing = false;
  #terminal = false;
  constructor(
    readonly session: Session,
    readonly id: number,
    readonly windowBytes: number,
    readonly windowMessages: number,
  ) {
    this.signal = AbortSignal.any([this.controller.signal, session.lifetime.signal]);
  }
  async write(plan: Plan): Promise<void> {
    if (this.#writing) throw failure('busy', 'Await publish before publishing again.');
    this.#writing = true;
    try {
      this.signal.throwIfAborted();
      if (this.#terminal) throw failure('closed', 'The operation has finished.');
      if (plan.bytes > this.windowBytes)
        throw failure('resource-limit', 'Publication exceeds its stream window.');
      while (
        this.#bytes + plan.bytes > this.windowBytes ||
        this.#entries.size >= this.windowMessages
      )
        await interrupt(this.#changed.promise, this.signal);
      this.signal.throwIfAborted();
      const sequence = integer(this.#sequence + 1, 1, 0xffffffff);
      this.#sequence = sequence;
      this.#entries.set(sequence, plan.bytes);
      this.#bytes += plan.bytes;
      try {
        await this.session.outbound.write(plan.bytes, () => plan.encode(sequence));
      } catch (error) {
        this.session.end(errorOf(error));
        throw error;
      }
    } finally {
      this.#writing = false;
    }
  }
  acknowledge(sequence: number, terminal = false): void {
    integer(sequence, terminal ? this.#acknowledged : this.#acknowledged + 1, this.#sequence);
    for (const [id, bytes] of this.#entries) {
      if (id > sequence) break;
      this.#bytes -= bytes;
      this.#entries.delete(id);
    }
    this.#acknowledged = sequence;
    this.#changed.resolve();
    this.#changed = deferred<void>();
    if (terminal) {
      if (!this.#terminal || this.#entries.size)
        throw failure('protocol', 'Invalid terminal acknowledgement.');
      this.session.senders.delete(this.id);
    }
  }
  cancel(reason: Error = failure('aborted', 'The operation was cancelled.')): void {
    this.controller.abort(reason);
    this.#changed.resolve();
  }
  async finish(op: Opcode, metadata: Record<string, unknown> = {}): Promise<void> {
    if (this.#terminal || this.session.lifetime.signal.aborted) return;
    // Invalid results must still permit a small error terminal; validate before committing state.
    prepare(op, this.id, metadata, [], this.session.bounds);
    this.#terminal = true;
    await this.session.control(op, this.id, metadata);
    // The bounded descriptor remains until consumption or cancellation; idle consumers do not kill unrelated streams.
  }
}
