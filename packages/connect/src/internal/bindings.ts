import type {
  Command,
  FieldSelection,
  Input,
  Model,
  Query,
  QueryBlock,
  QueryHeader,
  Queryable,
  QueryOptions,
  Recording,
  RetainOptions,
  Schema,
} from '@latkit/model';
import { blockBuffers, validateBlock, validateQuery, validateSchema } from '@latkit/model';
import type { Peer, Reply } from './peer.js';
import { aborted, errorValue, failure, interrupt } from './errors.js';
import { inspect, transferable } from './frame.js';

import type { Kind } from './validation.js';
import {
  record,
  recordOrEmpty,
  text,
  array,
  integer,
  stateKeys,
  validateState,
} from './validation.js';
import { bytes, readable } from './streams.js';
type Instance = Model | Recording | Queryable;
interface Reference {
  ref: number;
  kind: Kind;
  state: Record<string, unknown>;
  credit?: number;
}
interface Local {
  closing?: Promise<void>;
  kind: Kind;
  value?: Instance;
  iterator?: AsyncIterator<unknown>;
  controller: AbortController;
  owned?: boolean;
  pulling?: boolean;
  parent?: number;
  off: (() => void)[];
  state: Record<string, unknown>;
  credit?: number;
}
interface Remote {
  dispose?: () => void;
  reference: Reference;
  state: Record<string, unknown>;
  listeners: Map<string, Set<(value: unknown) => void>>;
  closed: boolean;
  closedNotified?: boolean;
}
/** Every method of a kind crosses; none is optional. */
const methods: Record<Kind, readonly string[]> = {
  model: ['describe', 'query', 'retain', 'close', 'monitor', 'run'],
  recording: ['describe', 'query', 'retain', 'close', 'export'],
  queryable: ['describe', 'query', 'retain', 'close'],
  stream: ['next', 'close'],
};
/** Known interfaces only: no arbitrary object reflection or user-selected method paths. */
export class Bindings {
  private nextRef = 1;
  private locals = new Map<number, Local>();
  private remotes = new Map<number, Remote>();
  private early = new Map<number, { event: string; state: unknown; value: unknown }[]>();
  private earlyBytes = 0;
  constructor(
    readonly peer: Peer,
    root?: { kind: 'model' | 'queryable'; value: Model | Queryable },
  ) {
    peer.invoke = this.invoke.bind(this);
    peer.event = this.event.bind(this);
    peer.orphan = this.orphan.bind(this);
    peer.dispose = this.dispose.bind(this);
    if (!root) return;
    const entry: Local = {
      kind: root.kind,
      value: root.value,
      controller: new AbortController(),
      off: [],
      state: this.metadata(root.kind, root.value),
    };
    this.locals.set(0, entry);
    this.watch(0, entry, root.kind, root.value);
  }
  async connectRoot(kind: 'model' | 'queryable'): Promise<Model | Queryable> {
    return this.importReference(await this.peer.call(0, 'acquire', { kind }), kind) as
      Model | Queryable;
  }
  private checkLimit(stream = false): void {
    if (
      this.locals.size >= this.peer.bounds.maxReferences ||
      (stream &&
        [...this.locals.values()].filter((e) => e.kind === 'stream').length >=
          this.peer.bounds.maxStreams)
    )
      throw failure('resource-limit', 'Reference limit exceeded.');
  }
  private metadata(kind: Exclude<Kind, 'stream'>, value: Instance): Record<string, unknown> {
    const v = value as unknown as Record<string, unknown>;
    const state: Record<string, unknown> = {};
    for (const key of stateKeys[kind]) if (v[key] !== undefined) state[key] = v[key];
    return state;
  }
  /** Tell the peer of each change, after the state it changed. The root closing ends the connection. */
  private watch(ref: number, entry: Local, kind: Exclude<Kind, 'stream'>, value: Instance): void {
    entry.off.push(
      value.on('change', (update) => {
        if (!this.locals.has(ref)) return;
        if (ref === 0 && update.kind === 'closed') {
          void this.peer.close();
          return;
        }
        const state = this.metadata(kind, value);
        const patch: Record<string, unknown> = {};
        for (const key of Object.keys(state))
          if (!Object.is(state[key], entry.state[key])) patch[key] = state[key];
        entry.state = state;
        this.peer.notify(ref, 'change', patch, update);
      }),
    );
  }
  private exportReference(
    kind: Exclude<Kind, 'stream'>,
    value: Instance,
    parent?: number,
  ): Reference {
    this.checkLimit();
    const ref = this.nextRef++;
    const entry: Local = {
      kind,
      value,
      parent,
      controller: new AbortController(),
      off: [],
      state: this.metadata(kind, value),
    };
    this.locals.set(ref, entry);
    try {
      this.watch(ref, entry, kind, value);
      return { ref, kind, state: entry.state };
    } catch (error) {
      for (const off of entry.off) off();
      this.locals.delete(ref);
      throw error;
    }
  }
  private exportStream(
    iterator: AsyncIterator<unknown>,
    parent?: number,
    controller = new AbortController(),
    owned = false,
    blockBytes = this.peer.blockBytes,
  ): Reference {
    try {
      this.checkLimit(true);
    } catch (error) {
      controller.abort();
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      throw error;
    }
    const ref = this.nextRef++;
    const credit = Math.min(
      this.peer.itemBytes,
      blockBytes + this.peer.bounds.maxMetadataBytes + 1024,
    );
    this.locals.set(ref, {
      kind: 'stream',
      iterator,
      parent,
      controller,
      owned,
      off: [],
      state: {},
      credit,
    });
    return { ref, kind: 'stream', state: {}, credit };
  }
  private descriptor(value: unknown, expected: Kind): Reference {
    const r = record(value);
    if (!integer(r.ref) || r.kind !== expected)
      throw failure('invalid-input', 'Invalid remote reference.');
    validateState(expected, record(r.state));
    if (this.remotes.size >= this.peer.bounds.maxReferences)
      throw failure('resource-limit', 'Remote reference limit exceeded.');
    return r as unknown as Reference;
  }
  private importReference(value: unknown, expected: Exclude<Kind, 'stream'>): Instance {
    const reference = this.descriptor(value, expected);
    if (this.remotes.has(reference.ref)) throw failure('invalid-input', 'Duplicate acquisition.');
    const remote: Remote = {
      reference,
      state: { ...reference.state },
      listeners: new Map(),
      closed: false,
    };
    this.remotes.set(reference.ref, remote);
    const output: Record<string, unknown> = {};
    for (const key of stateKeys[expected])
      Object.defineProperty(output, key, { enumerable: true, get: () => remote.state[key] });
    output.on = (event: string, listener: (value: unknown) => void): (() => void) => {
      if (remote.closed) throw failure('closed');
      const listeners = remote.listeners.get(event) ?? new Set();
      listeners.add(listener);
      remote.listeners.set(event, listeners);
      return () => {
        listeners.delete(listener);
      };
    };
    const call = async (method: string, args: unknown, signal?: AbortSignal): Promise<unknown> => {
      if (remote.closed) throw failure('closed');
      return this.peer.call(reference.ref, method, args, signal);
    };
    for (const method of methods[expected]) {
      if (method === 'close') {
        output.close = async (): Promise<void> => {
          if (remote.closed) return;
          try {
            await call('close', null);
          } finally {
            this.closeRemote(remote);
          }
        };
        continue;
      }
      if (method === 'query') {
        output.query = (query: Query, options: QueryOptions = {}) => ({
          [Symbol.asyncIterator]: () => this.query(reference.ref, query, options, remote),
        });
        continue;
      }
      output[method] = async (...args: unknown[]): Promise<unknown> => {
        if (remote.closed) throw failure('closed');
        const options = recordOrEmpty(args[method === 'monitor' || method === 'run' ? 1 : 0]);
        const signal = options.signal as AbortSignal | undefined;
        let encoded: unknown = null;
        const firstRef = this.nextRef;
        try {
          if (method === 'monitor') encoded = array(args[0]);
          else if (method === 'run') encoded = this.encodeCommand(args[0] as Command);
          else if (method === 'retain')
            encoded = { window: options.window, maxBytes: options.maxBytes };
        } catch (error) {
          await Promise.allSettled(
            Array.from({ length: this.nextRef - firstRef }, (_, i) => this.release(firstRef + i)),
          );
          throw error;
        }
        let result: unknown;
        try {
          result = await call(method, encoded, signal);
        } catch (error) {
          this.releaseOutgoing(encoded);
          throw error;
        }
        try {
          if (method === 'retain') return this.importReference(result, 'queryable');
          if (method === 'monitor') return this.importReference(result, 'recording');
          if (method === 'export') {
            const data = record(result);
            return { ...data, stream: readable(this.importStream(data.stream, signal)) };
          }
          if (method === 'describe' && validateSchema(result).length)
            throw failure('invalid-input', 'Remote schema is invalid.');
          return result;
        } catch (error) {
          this.orphan(result);
          throw error;
        }
      };
    }
    const pending = this.early.get(reference.ref);
    this.early.delete(reference.ref);
    if (pending) {
      for (const event of pending) this.event(reference.ref, event.event, event.state, event.value);
      this.recountEarly();
    }
    return output as unknown as Instance;
  }
  private event(ref: number, event: string, state: unknown, value: unknown): void {
    const remote = this.remotes.get(ref);
    if (!remote) {
      if (event === 'released') {
        this.early.delete(ref);
        this.recountEarly();
        return;
      }
      const list = this.early.get(ref) ?? [];
      list.push({ event, state, value });
      this.early.set(ref, list);
      this.earlyBytes += inspect({ state, value }, this.peer.bounds).bytes;
      if (
        this.early.size > this.peer.bounds.maxReferences ||
        list.length > this.peer.bounds.maxStreams ||
        this.earlyBytes > this.peer.bounds.maxInFlightBytes
      )
        throw failure('resource-limit', 'Pending event limit exceeded.');
      return;
    }
    if (remote.closed) return;
    if (event === 'released') {
      this.closeRemote(remote);
      return;
    }
    if (event !== 'change') throw failure('invalid-input', 'Unknown event.');
    if (record(value).kind === 'closed') remote.closedNotified = true;
    const patch = record(state);
    validateState(remote.reference.kind, { ...remote.state, ...patch });
    for (const [key, value] of Object.entries(patch))
      Object.defineProperty(remote.state, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    for (const listener of remote.listeners.get(event) ?? []) listener(value);
  }
  private recountEarly(): void {
    this.earlyBytes = 0;
    for (const list of this.early.values())
      for (const event of list)
        this.earlyBytes += inspect(
          { state: event.state, value: event.value },
          this.peer.bounds,
        ).bytes;
  }
  private closeRemote(remote: Remote): void {
    remote.dispose?.();
    remote.closed = true;
    if (!remote.closedNotified) {
      remote.closedNotified = true;
      for (const listener of remote.listeners.get('change') ?? []) listener({ kind: 'closed' });
    }
    remote.listeners.clear();
    this.remotes.delete(remote.reference.ref);
  }
  private encodeInput(input: Input): unknown {
    return {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      stream: this.exportStream(bytes(input.stream, this.peer.blockBytes)[Symbol.asyncIterator]()),
    };
  }
  private decodeInput(value: unknown, signal?: AbortSignal): Input {
    const input = record(value);
    return {
      ...(input.name === undefined ? {} : { name: text(input.name) }),
      ...(input.mediaType === undefined ? {} : { mediaType: text(input.mediaType) }),
      stream: readable(this.importStream(input.stream, signal)),
    };
  }
  private encodeCommand(command: Command): unknown {
    const encode = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(encode)
        : value && typeof value === 'object'
          ? this.encodeInput(value as Input)
          : value;
    return {
      routine: command.routine,
      values: Object.fromEntries(
        Object.entries(command.values).map(([key, value]) => [key, encode(value)]),
      ),
    };
  }
  private decodeCommand(value: unknown, signal?: AbortSignal): Command {
    const command = record(value);
    const decode = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(decode)
        : v && typeof v === 'object'
          ? this.decodeInput(v, signal)
          : v;
    return {
      routine: text(command.routine),
      values: Object.fromEntries(
        Object.entries(record(command.values)).map(([key, value]) => [key, decode(value)]),
      ) as Command['values'],
    };
  }
  private importStream(value: unknown, signal?: AbortSignal): AsyncIterableIterator<unknown> {
    const reference = this.descriptor(value, 'stream');
    if (this.remotes.has(reference.ref)) throw failure('invalid-input', 'Duplicate stream.');
    if (
      !integer(reference.credit) ||
      reference.credit < 1 ||
      reference.credit > this.peer.itemBytes
    )
      throw failure('invalid-input', 'Invalid stream credit.');
    if (
      [...this.remotes.values()].filter((r) => r.reference.kind === 'stream').length >=
      this.peer.bounds.maxStreams
    )
      throw failure('resource-limit', 'Remote stream limit exceeded.');
    const remote: Remote = { reference, state: {}, listeners: new Map(), closed: false };
    this.remotes.set(reference.ref, remote);
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
      void close().catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    let pulling = false;
    let closing: Promise<IteratorResult<unknown>> | undefined;
    const close = (): Promise<IteratorResult<unknown>> =>
      (closing ??= (async () => {
        if (remote.closed) return { done: true, value: undefined };
        remote.closed = true;
        controller.abort();
        signal?.removeEventListener('abort', abort);
        this.remotes.delete(reference.ref);
        try {
          await this.peer.call(reference.ref, 'close', null);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
        return { done: true, value: undefined };
      })());
    remote.dispose = () => {
      controller.abort();
      signal?.removeEventListener('abort', abort);
    };
    if (signal?.aborted) abort();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        aborted(signal);
        if (remote.closed) return { done: true, value: undefined };
        if (pulling) throw failure('busy', 'Concurrent pulls are unsupported.');
        pulling = true;
        let release: (() => void) | undefined;
        try {
          release = await this.peer.reserve(reference.credit!, controller.signal);
          const result = record(
            await this.peer.call(reference.ref, 'next', null, controller.signal, reference.credit),
          );
          if (typeof result.done !== 'boolean')
            throw failure('invalid-input', 'Invalid iterator result.');
          if (result.done) {
            remote.closed = true;
            signal?.removeEventListener('abort', abort);
            this.remotes.delete(reference.ref);
          }
          return { done: result.done, value: result.value };
        } catch (error) {
          await close();
          throw error;
        } finally {
          release?.();
          pulling = false;
        }
      },
      return: close,
      throw: async (error?: unknown) => {
        await close();
        throw errorValue(error);
      },
    };
  }
  private query(
    ref: number,
    query: Query,
    options: QueryOptions,
    remote: Remote,
  ): AsyncIterableIterator<QueryHeader | QueryBlock> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();

    let started: Promise<AsyncIterableIterator<unknown>> | undefined;
    let ended = false;
    let header: QueryHeader | undefined;
    const start = (): Promise<AsyncIterableIterator<unknown>> =>
      (started ??= (async () => {
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        if (remote.closed) throw failure('closed');
        const descriptor = await this.peer.call(
          ref,
          'query',
          { query, options: { buffers: options.buffers, maxBlockBytes: options.maxBlockBytes } },
          controller.signal,
        );
        return this.importStream(descriptor, controller.signal);
      })());
    const close = async (): Promise<IteratorResult<QueryHeader | QueryBlock>> => {
      if (ended) return { done: true, value: undefined };
      ended = true;
      controller.abort();
      options.signal?.removeEventListener('abort', abort);
      if (started) {
        try {
          await (await started).return?.();
        } catch {
          /* Rejected setup has no live stream. */
        }
      }
      return { done: true, value: undefined };
    };
    const iterator: AsyncIterableIterator<QueryHeader | QueryBlock> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (ended) return { done: true, value: undefined };
        aborted(options.signal);
        try {
          const stream = await start();
          if (remote.closed) throw failure('closed');
          const result = await stream.next();
          if (remote.closed) throw failure('closed');
          if (result.done) {
            if (!header) throw failure('invalid-input', 'Missing query header.');
            ended = true;
            options.signal?.removeEventListener('abort', abort);
            return { done: true, value: undefined };
          }
          let block = record(result.value);
          if (block.kind === 'schema') {
            if (header || validateSchema(block.schema).length || typeof block.version !== 'string')
              throw failure('invalid-input', 'Invalid query header.');
            const problems = validateQuery(block.schema as Schema, query);
            if (problems.length)
              throw failure('invalid-input', 'Query differs from its returned schema.');
            header = block as unknown as QueryHeader;
          } else {
            if (!header || block.version !== header.version)
              throw failure('conflict', 'Incoherent query stream.');
            const limit = Math.min(
              options.maxBlockBytes ?? Infinity,
              header.schema.limits.maxBlockBytes,
            );
            if (
              options.buffers === 'owned' &&
              blockBuffers(block as unknown as QueryBlock).reduce((n, b) => n + b.byteLength, 0) >
                limit
            )
              block = transferable(block, this.peer.bounds).value as Record<string, unknown>;
            const problems = validateBlock(header.schema, query, block, options);
            if (problems.length)
              throw Object.assign(
                failure(
                  problems[0].code === 'resource-limit' ? 'resource-limit' : 'invalid-input',
                  'Invalid remote block.',
                ),
                { issues: problems },
              );
          }
          return { done: false, value: block as unknown as QueryHeader | QueryBlock };
        } catch (error) {
          await close();
          throw error;
        }
      },
      return: close,
      throw: async (error?: unknown) => {
        await close();
        throw errorValue(error);
      },
    };
    return iterator;
  }
  private async invoke(
    ref: number,
    method: string,
    args: unknown,
    signal: AbortSignal,
    credit: number,
  ): Promise<Reply> {
    const entry = this.locals.get(ref);
    if (!entry || (entry.closing && method !== 'close')) throw failure('closed');
    if (method !== 'close') signal = AbortSignal.any([signal, entry.controller.signal]);
    aborted(signal);
    if (ref === 0 && method === 'acquire') {
      if (record(args).kind !== entry.kind)
        throw failure('unsupported', 'Connection capability mismatch.');
      return { value: { ref: 0, kind: entry.kind, state: entry.state } };
    }
    if (!methods[entry.kind].includes(method))
      throw failure('unsupported', 'Unknown contract method.');
    if (method === 'close') {
      await this.release(ref);
      return { value: null };
    }
    if (entry.kind === 'stream') {
      if (method !== 'next' || !credit || credit < entry.credit!)
        throw failure('invalid-input', 'Missing pull credit.');
      if (entry.pulling) throw failure('busy');
      entry.pulling = true;
      const abort = (): void => {
        entry.controller.abort();
        void this.release(ref).catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await interrupt(Promise.resolve(entry.iterator!.next()), signal);
        if (result.done) await this.release(ref);
        return {
          value: { done: result.done === true, value: result.value as unknown },
          owned: entry.owned,
        };
      } finally {
        entry.pulling = false;
        signal.removeEventListener('abort', abort);
      }
    }
    const value = entry.value!;
    const source = value as Queryable;
    if (method === 'query') {
      const request = record(args),
        opts = record(request.options);
      if (opts.buffers !== undefined && opts.buffers !== 'owned' && opts.buffers !== 'borrowed')
        throw failure('invalid-input');
      if (
        opts.maxBlockBytes !== undefined &&
        (!integer(opts.maxBlockBytes) || opts.maxBlockBytes < 1)
      )
        throw failure('invalid-input');
      const controller = new AbortController();
      const bound = Math.min(Number(opts.maxBlockBytes ?? Infinity), this.peer.blockBytes);
      const buffers = this.peer.transport.transfers
        ? 'owned'
        : (opts.buffers as QueryOptions['buffers']);
      const iterator = source
        .query(record(request.query) as unknown as Query, {
          signal: controller.signal,
          buffers,
          maxBlockBytes: bound,
        })
        [Symbol.asyncIterator]();
      const result = this.exportStream(iterator, ref, controller, buffers === 'owned', bound);
      return { value: result, discard: () => this.release(result.ref) };
    }
    if (method === 'retain') {
      const options = record(args);
      if (options.maxBytes !== undefined && (!integer(options.maxBytes) || options.maxBytes < 1))
        throw failure('invalid-input');
      const retained = await source.retain({ ...options, signal } as RetainOptions);
      try {
        aborted(signal);
        const descriptor = this.exportReference('queryable', retained);
        return { value: descriptor, discard: () => this.release(descriptor.ref) };
      } catch (error) {
        await retained.close();
        throw error;
      }
    }
    if (method === 'describe') return { value: await source.describe({ signal }) };
    if (method === 'export') {
      const result = await (value as Recording).export({ signal });
      const stream = this.exportStream(
        bytes(result.stream, this.peer.blockBytes)[Symbol.asyncIterator](),
        ref,
      );
      return {
        value: { version: result.version, mediaType: result.mediaType, stream },
        discard: () => this.release(stream.ref),
      };
    }
    const model = value as Model;
    if (method === 'monitor') {
      const recording = await model.monitor(array(args) as unknown as FieldSelection[], {
        signal,
      });
      if (signal.aborted) {
        await recording.close();
        throw failure('aborted');
      }
      try {
        const descriptor = this.exportReference('recording', recording);
        return { value: descriptor, discard: () => this.release(descriptor.ref) };
      } catch (error) {
        await recording.close();
        throw error;
      }
    }
    if (method === 'run')
      return { value: await model.run(this.decodeCommand(args, signal), { signal }) };
    throw failure('unsupported', 'Method is not implemented.');
  }
  private async release(ref: number): Promise<void> {
    const entry = this.locals.get(ref);
    if (!entry || ref === 0) return;
    if (entry.closing) return entry.closing;
    entry.controller.abort();
    if (entry.iterator) {
      this.locals.delete(ref);
      void Promise.resolve(entry.iterator.return?.()).catch(() => undefined);
      return;
    }
    entry.closing = Promise.resolve().then(async () => {
      try {
        const children = [...this.locals]
          .filter(([, child]) => child.parent === ref)
          .map(([id]) => this.release(id));
        await Promise.all([entry.value?.close(), ...children]);
      } finally {
        for (const off of entry.off) off();
        this.locals.delete(ref);
        this.peer.notify(ref, 'released', {});
      }
    });
    return entry.closing;
  }
  /** A descriptor this side exported: a reference, with its kind and state. */
  private static described(value: Record<string, unknown>): boolean {
    return integer(value.ref) && typeof value.kind === 'string' && !!value.state;
  }
  private releaseOutgoing(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (Bindings.described(v)) {
      void this.release(v.ref as number).catch(() => undefined);
      return;
    }
    for (const child of Object.values(v)) this.releaseOutgoing(child);
  }
  private orphan(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (Bindings.described(v)) {
      this.early.delete(v.ref as number);
      this.recountEarly();
      void this.peer.call(v.ref as number, 'close', null).catch(() => undefined);
      return;
    }
    for (const child of Object.values(v)) this.orphan(child);
  }
  private async dispose(): Promise<void> {
    for (const remote of this.remotes.values()) this.closeRemote(remote);
    this.remotes.clear();
    this.early.clear();
    // Abort streams before waiting for close methods which may themselves be waiting on them.
    for (const entry of this.locals.values()) entry.controller.abort();
    const refs = [...this.locals.keys()].filter((ref) => ref !== 0);
    await Promise.allSettled(refs.map((ref) => this.release(ref)));
    for (const off of this.locals.get(0)?.off ?? []) off();
    this.locals.clear();
  }
}
