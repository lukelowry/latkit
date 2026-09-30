import type {
  ModelService,
  Document,
  Model,
  Recording,
  Resource,
  Input,
  OpenInput,
  Command,
  Query,
  QueryBlock,
  QueryHeader,
  Queryable,
  QueryOptions,
  RetainOptions,
  MonitorConfig,
  Edit,
  ResourceRead,
  ResourceWrite,
  SaveOptions,
  Schema,
} from '@latkit/model';
import { blockBuffers, validateBlock, validateQuery, validateSchema } from '@latkit/model';
import type { Peer, Reply } from './peer.js';
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
import { inspect, transferable } from './frame.js';

import type { Kind } from './validation.js';
import { record, recordOrEmpty, text, array, integer, validateState } from './validation.js';
import { bytes, parts, checkedParts, readable } from './streams.js';
type Instance = ModelService | Document | Model | Recording | Resource | Queryable;
interface Reference {
  ref: number;
  kind: Kind;
  state: Record<string, unknown>;
  methods: string[];
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
  ready?: Deferred<void>;
  done?: Deferred<unknown>;
  closed: boolean;
  closedNotified?: boolean;
}
const methods: Record<Kind, readonly string[]> = {
  service: ['open', 'document', 'model', 'recording'],
  document: ['describe', 'query', 'retain', 'edit', 'save', 'reload', 'attach', 'export', 'close'],
  model: ['parse', 'validate', 'call', 'monitor', 'reset', 'close'],
  recording: ['describe', 'query', 'retain', 'commands', 'diagnostics', 'stop', 'export', 'close'],
  resource: ['stat', 'read', 'write', 'close'],
  queryable: ['describe', 'query', 'retain', 'close'],
  stream: ['next', 'close'],
};
const required: Record<Kind, readonly string[]> = {
  service: ['open', 'document', 'model', 'recording'],
  document: ['describe', 'query', 'retain', 'close'],
  model: ['reset', 'close'],
  recording: ['describe', 'query', 'retain', 'commands', 'diagnostics', 'stop', 'close'],
  resource: ['stat', 'read', 'close'],
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
    root?: { kind: 'service' | 'queryable'; value: ModelService | Queryable },
  ) {
    if (root)
      this.locals.set(0, {
        kind: root.kind,
        value: root.value,
        controller: new AbortController(),
        off: [],
        state: {},
      });
    peer.invoke = this.invoke.bind(this);
    peer.event = this.event.bind(this);
    peer.orphan = this.orphan.bind(this);
    peer.dispose = this.dispose.bind(this);
    if (root?.kind === 'queryable') {
      const source = root.value as Queryable;
      const entry = this.locals.get(0)!;
      entry.state = this.metadata('queryable', source);
      entry.off.push(
        source.on('change', (change) => {
          if (change.kind === 'closed') {
            void peer.close();
            return;
          }
          entry.state = this.metadata('queryable', source);
          peer.notify(0, 'change', entry.state, change);
        }),
      );
    }
  }
  async connectRoot(kind: 'service' | 'queryable'): Promise<ModelService | Queryable> {
    return this.importReference(await this.peer.call(0, 'acquire', { kind }), kind) as
      ModelService | Queryable;
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
  private metadata(kind: Kind, value: Instance): Record<string, unknown> {
    const v = value as unknown as Record<string, unknown>;
    const keys =
      kind === 'service'
        ? ['id', 'label', 'formats']
        : kind === 'document'
          ? ['id', 'name', 'format', 'version', 'saved']
          : kind === 'model'
            ? ['id', 'label', 'documentId', 'routines']
            : kind === 'recording'
              ? [
                  'id',
                  'scope',
                  'modelId',
                  'documentId',
                  'documentVersion',
                  'status',
                  'fields',
                  'axis',
                  'firstFrame',
                  'frameCount',
                  'range',
                  'error',
                  'version',
                ]
              : kind === 'queryable'
                ? ['version']
                : ['id', 'name', 'mediaType'];
    const state: Record<string, unknown> = {};
    for (const key of keys)
      if (v[key] !== undefined)
        state[key] = key === 'error' && v[key] ? encodeError(v[key]) : v[key];
    return state;
  }
  private exportReference(
    kind: Exclude<Kind, 'stream'>,
    value: Instance,
    parent?: number,
  ): Reference {
    try {
      this.checkLimit();
    } catch (error) {
      if (kind === 'resource') void (value as Resource).close().catch(() => undefined);
      throw error;
    }
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
    const publish = (event: string, payload?: unknown): void => {
      if (!this.locals.has(ref)) return;
      const state = this.metadata(kind, value);
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(state))
        if (!Object.is(state[key], entry.state[key])) patch[key] = state[key];
      entry.state = state;
      this.peer.notify(ref, event, patch, payload);
    };
    try {
      if (kind === 'document') {
        const document = value as Document;
        entry.off.push(document.on('change', (update) => publish('change', update)));
        entry.off.push(document.on('saved', (saved) => publish('saved', saved)));
      }
      if (kind === 'queryable')
        entry.off.push((value as Queryable).on('change', (update) => publish('change', update)));
      if (kind === 'recording') {
        const recording = value as Recording;
        entry.off.push(recording.on('change', (update) => publish('change', update)));
        void recording.ready.then(
          () => publish('ready'),
          (error) => publish('ready-error', encodeError(error)),
        );
        void recording.done.then(
          (outcome) =>
            publish(
              'done',
              outcome.status === 'failed'
                ? { ...outcome, error: encodeError(outcome.error) }
                : outcome,
            ),
          (error) => publish('done-error', encodeError(error)),
        );
      }
      if (kind === 'model') {
        const model = value as Model;
        entry.off.push(model.on('routines', () => publish('routines')));
        entry.off.push(model.on('reset', () => publish('reset')));
        entry.off.push(
          model.on('command', (event) =>
            publish(
              'command',
              event.kind === 'failed' ? { ...event, error: encodeError(event.error) } : event,
            ),
          ),
        );
        entry.off.push(model.on('diagnostic', (event) => publish('diagnostic', event)));
      }
      return {
        ref,
        kind,
        state: entry.state,
        methods: methods[kind].filter(
          (method) => typeof (value as unknown as Record<string, unknown>)[method] === 'function',
        ),
      };
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
    return { ref, kind: 'stream', state: {}, methods: ['next', 'close'], credit };
  }
  private descriptor(value: unknown, expected: Kind): Reference {
    const r = record(value);
    if (
      !integer(r.ref) ||
      r.kind !== expected ||
      !Array.isArray(r.methods) ||
      !r.methods.every((v) => typeof v === 'string' && methods[expected].includes(v)) ||
      !required[expected].every((method) => (r.methods as unknown[]).includes(method))
    )
      throw failure('invalid-input', 'Invalid remote reference.');
    record(r.state);
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
    for (const key of Object.keys(reference.state))
      Object.defineProperty(output, key, {
        enumerable: true,
        get: () =>
          key === 'error' && remote.state[key] ? decodeError(remote.state[key]) : remote.state[key],
      });
    if (expected === 'recording') {
      remote.ready = deferred<void>();
      remote.done = deferred<unknown>();
      output.ready = remote.ready.promise;
      output.done = remote.done.promise;
    }
    if (
      expected === 'document' ||
      expected === 'recording' ||
      expected === 'queryable' ||
      expected === 'model'
    )
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
    const close = async (): Promise<void> => {
      if (remote.closed) return;
      try {
        await call('close', null);
      } finally {
        this.closeRemote(remote);
      }
    };
    for (const method of reference.methods) {
      if (method === 'close') {
        output.close = close;
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
        const options = recordOrEmpty(
          args[
            method === 'retain' ||
            method === 'describe' ||
            method === 'reset' ||
            method === 'stop' ||
            method === 'export' ||
            method === 'stat' ||
            method === 'save' ||
            method === 'reload'
              ? 0
              : 1
          ],
        );
        const signal = options.signal as AbortSignal | undefined;
        let encoded: unknown = args[0] ?? null;
        let result: unknown;
        const firstRef = this.nextRef;
        try {
          switch (method) {
            case 'open':
              encoded = this.encodeInput(args[0] as OpenInput | undefined);
              break;
            case 'parse':
              encoded = this.encodeInput(args[0] as Input);
              break;
            case 'validate':
            case 'call':
              encoded = {
                command: this.encodeCommand(args[0] as Command, method === 'validate'),
                options: method === 'call' ? { id: options.id } : {},
              };
              break;
            case 'save': {
              const save = options as SaveOptions;
              encoded = {
                to: save.to
                  ? {
                      resource: this.exportReference('resource', save.to.resource),
                      base: save.to.base,
                    }
                  : undefined,
              };
              break;
            }
            case 'attach':
              encoded = this.exportReference('resource', args[0] as Resource);
              break;
            case 'write': {
              const request = args[0] as ResourceWrite;
              encoded = {
                base: request.base,
                parts: this.exportStream(
                  parts(request.parts, this.peer.blockBytes)[Symbol.asyncIterator](),
                ),
              };
              break;
            }
            case 'export':
            case 'describe':
            case 'reset':
            case 'stop':
            case 'stat':
              encoded = null;
              break;
            case 'retain':
              encoded = { window: options.window, maxBytes: options.maxBytes };
              break;
            case 'reload':
              encoded = { discardChanges: options.discardChanges };
              break;
          }
        } catch (error) {
          await Promise.allSettled(
            Array.from({ length: this.nextRef - firstRef }, (_, i) => this.release(firstRef + i)),
          );
          throw error;
        }
        try {
          result = await call(method, encoded, signal);
        } catch (error) {
          this.releaseOutgoing(encoded);
          throw error;
        } finally {
          if (method === 'validate') this.releaseOutgoing(encoded);
        }
        try {
          if (method === 'open' || method === 'document')
            return this.importReference(result, 'document');
          if (method === 'model') return this.importReference(result, 'model');
          if (method === 'retain') return this.importReference(result, 'queryable');
          if (method === 'monitor' || method === 'recording')
            return this.importReference(result, 'recording');
          if (method === 'read') return readable(this.importStream(result, signal));
          if (method === 'export') {
            const data = record(result);
            return { ...data, stream: readable(this.importStream(data.stream, signal)) };
          }
          if (method === 'parse') return this.decodeCommand(result);
          if (method === 'describe') {
            const problems = validateSchema(result);
            if (problems.length) throw failure('invalid-input', 'Remote schema is invalid.');
          }
          return this.decodeResult(method, result);
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
  private decodeResult(method: string, result: unknown): unknown {
    if (method === 'commands') {
      const page = record(result);
      return {
        ...page,
        items: array(page.items).map((item) => {
          const entry = record(item);
          return entry.status === 'failed' ? { ...entry, error: decodeError(entry.error) } : entry;
        }),
      };
    }
    return result;
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
    if (event === 'change' && record(value).kind === 'closed') remote.closedNotified = true;
    if (event === 'released') {
      this.closeRemote(remote);
      return;
    }
    const patch = record(state);
    validateState(remote.reference.kind, { ...remote.state, ...patch });
    for (const [key, value] of Object.entries(patch))
      Object.defineProperty(remote.state, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    if (event === 'ready') remote.ready?.resolve();
    else if (event === 'ready-error') remote.ready?.reject(decodeError(value));
    else if (event === 'done') {
      const outcome = record(value);
      remote.done?.resolve(
        outcome.status === 'failed' ? { ...outcome, error: decodeError(outcome.error) } : outcome,
      );
    } else if (event === 'done-error') remote.done?.reject(decodeError(value));
    else {
      let payload = value;
      if (event === 'command' && record(value).kind === 'failed')
        payload = { ...record(value), error: decodeError(record(value).error) };
      for (const listener of remote.listeners.get(event) ?? []) listener(payload);
    }
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
    remote.ready?.reject(failure('closed'));
    remote.done?.reject(failure('closed'));
    if (!remote.closedNotified) {
      remote.closedNotified = true;
      for (const listener of remote.listeners.get('change') ?? []) listener({ kind: 'closed' });
    }
    remote.listeners.clear();
    this.remotes.delete(remote.reference.ref);
  }
  private encodeInput(input: OpenInput | undefined, preflight = false): unknown {
    if (input === undefined) return null;
    if (input.kind === 'resource')
      return {
        kind: 'resource',
        resource: this.exportReference(
          'resource',
          preflight
            ? {
                id: input.resource.id,
                name: input.resource.name,
                mediaType: input.resource.mediaType,
                stat: input.resource.stat.bind(input.resource),
                read: () =>
                  Promise.reject(failure('unsupported', 'Validation cannot consume input.')),
                close: () => Promise.resolve(),
              }
            : input.resource,
        ),
      };
    if (input.kind === 'content')
      return {
        ...input,
        stream: this.exportStream(
          bytes(
            preflight
              ? new ReadableStream<Uint8Array>(
                  {
                    pull() {
                      throw failure('unsupported', 'Validation cannot consume input.');
                    },
                  },
                  { highWaterMark: 0 },
                )
              : input.stream,
            this.peer.blockBytes,
          )[Symbol.asyncIterator](),
        ),
      };
    return input;
  }
  private decodeInput(value: unknown, empty = false, signal?: AbortSignal): OpenInput | undefined {
    if (value === null) return undefined;
    const input = record(value);
    if (input.kind === 'resource')
      return {
        kind: 'resource',
        resource: this.importReference(input.resource, 'resource') as Resource,
      };
    if (input.kind === 'content')
      return {
        kind: 'content',
        ...(input.name === undefined ? {} : { name: text(input.name) }),
        ...(input.mediaType === undefined ? {} : { mediaType: text(input.mediaType) }),
        stream: readable(this.importStream(input.stream, signal)),
      };
    if (input.kind === 'reference') return { kind: 'reference', value: text(input.value) };
    if (empty && input.kind === 'empty')
      return {
        kind: 'empty',
        format: text(input.format),
        ...(input.name === undefined ? {} : { name: text(input.name) }),
      };
    throw failure('invalid-input', 'Unknown input kind.');
  }
  private encodeCommand(command: Command, preflight = false): unknown {
    return {
      routine: command.routine,
      values: Object.fromEntries(
        Object.entries(command.values).map(([key, value]) => [
          key,
          this.encodeValue(value, preflight),
        ]),
      ),
    };
  }
  private encodeValue(value: unknown, preflight = false): unknown {
    if (Array.isArray(value)) return value.map((item) => this.encodeValue(item, preflight));
    if (value && typeof value === 'object') return this.encodeInput(value as Input, preflight);
    return value;
  }
  private decodeCommand(value: unknown, signal?: AbortSignal): Command {
    const command = record(value);
    const decode = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(decode)
        : v && typeof v === 'object'
          ? this.decodeInput(v, false, signal)
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
      return {
        value: {
          ref: 0,
          kind: entry.kind,
          state: this.metadata(entry.kind, entry.value!),
          methods: [...methods[entry.kind]],
        },
      };
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
      const operation = (value as Document).export;
      if (!operation) throw failure('unsupported');
      const result = await operation.call(value, { signal });
      const stream = this.exportStream(
        bytes(result.stream, this.peer.blockBytes)[Symbol.asyncIterator](),
        ref,
      );
      return {
        value: { version: result.version, mediaType: result.mediaType, stream },
        discard: () => this.release(stream.ref),
      };
    }
    if (entry.kind === 'service') {
      const service = value as ModelService;
      let result: Document | Model | Recording;
      if (method === 'open')
        result = await service.open(this.decodeInput(args, true, signal), { signal });
      else if (method === 'document') result = await service.document(text(args), { signal });
      else if (method === 'recording') result = await service.recording(text(args), { signal });
      else result = await service.model(text(args), { signal });
      if (signal.aborted) {
        await result.close();
        throw failure('aborted');
      }
      try {
        const descriptor = this.exportReference(
          method === 'model' ? 'model' : method === 'recording' ? 'recording' : 'document',
          result,
        );
        return { value: descriptor, discard: () => this.release(descriptor.ref) };
      } catch (error) {
        await result.close();
        throw error;
      }
    }
    if (entry.kind === 'document') {
      const document = value as Document;
      if (method === 'edit') {
        if (!document.edit) throw failure('unsupported');
        return {
          value: await document.edit(array(args) as unknown as readonly Edit[], { signal }),
        };
      }
      if (method === 'save') {
        if (!document.save) throw failure('unsupported');
        const request = record(args);
        let to: SaveOptions['to'];
        if (request.to !== undefined) {
          const target = record(request.to);
          if (target.base !== null) text(target.base);
          to = {
            resource: this.importReference(target.resource, 'resource') as Resource,
            base: target.base as string | null,
          };
        }
        return { value: await document.save({ signal, to }) };
      }
      if (method === 'reload') {
        if (!document.reload) throw failure('unsupported');
        const request = record(args);
        if (request.discardChanges !== undefined && typeof request.discardChanges !== 'boolean')
          throw failure('invalid-input');
        return {
          value: await document.reload({
            signal,
            discardChanges: request.discardChanges as boolean | undefined,
          }),
        };
      }
      if (method === 'attach') {
        if (!document.attach) throw failure('unsupported');
        await document.attach(this.importReference(args, 'resource') as Resource, { signal });
        return { value: null };
      }
    }
    if (entry.kind === 'model') {
      const model = value as Model;
      if (method === 'reset') {
        await model.reset();
        return { value: null };
      }
      if (method === 'parse') {
        if (!model.parse) throw failure('unsupported');
        const input = this.decodeInput(args, false, signal);
        if (!input || input.kind === 'empty') throw failure('invalid-input');
        return { value: this.encodeCommand(await model.parse(input, { signal })) };
      }
      if (method === 'validate' || method === 'call') {
        const request = record(args),
          command = this.decodeCommand(request.command, signal),
          opts = record(request.options);
        if (method === 'validate') {
          if (!model.validate) throw failure('unsupported');
          try {
            return { value: await model.validate(command, { signal }) };
          } finally {
            await this.releaseIncoming(request.command);
          }
        }
        if (!model.call) throw failure('unsupported');
        if (opts.id !== undefined) text(opts.id);
        return { value: await model.call(command, { signal, id: opts.id as string | undefined }) };
      }
      if (method === 'monitor') {
        if (!model.monitor) throw failure('unsupported');
        const recording = await model.monitor(record(args) as unknown as MonitorConfig, { signal });
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
    }
    if (entry.kind === 'recording') {
      const recording = value as Recording;
      if (method === 'stop') {
        await recording.stop();
        return { value: null };
      }
      const page = record(args);
      if (!integer(page.limit) || page.limit < 1) throw failure('invalid-input');
      if (method === 'commands') {
        if (page.offset !== undefined && !integer(page.offset)) throw failure('invalid-input');
        const result = await recording.commands(
          { limit: page.limit, offset: page.offset as number | undefined },
          { signal },
        );
        return {
          value: {
            ...result,
            items: result.items.map((item) =>
              item.status === 'failed' ? { ...item, error: encodeError(item.error) } : item,
            ),
          },
        };
      }
      if (method === 'diagnostics') {
        if (page.after !== undefined && !integer(page.after)) throw failure('invalid-input');
        return {
          value: await recording.diagnostics(
            { limit: page.limit, after: page.after as number | undefined },
            { signal },
          ),
        };
      }
    }
    if (entry.kind === 'resource') {
      const resource = value as Resource;
      if (method === 'stat') return { value: await resource.stat({ signal }) };
      if (method === 'read') {
        const request = record(args);
        text(request.tag);
        if (request.range !== undefined) {
          const range = record(request.range);
          if (!integer(range.offset) || !integer(range.length)) throw failure('invalid-input');
        }
        const stream = await resource.read(request as unknown as ResourceRead, { signal });
        const descriptor = this.exportStream(
          bytes(stream, this.peer.blockBytes)[Symbol.asyncIterator](),
          ref,
        );
        return { value: descriptor, discard: () => this.release(descriptor.ref) };
      }
      if (method === 'write') {
        if (!resource.write) throw failure('unsupported');
        const request = record(args);
        if (request.base !== null) text(request.base);
        const parts = this.importStream(request.parts, signal);
        try {
          return {
            value: await resource.write(
              { base: request.base as string | null, parts: checkedParts(parts) },
              { signal },
            ),
          };
        } finally {
          await parts.return?.();
        }
      }
    }
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
        await Promise.all([
          entry.value && 'close' in entry.value ? entry.value.close() : undefined,
          ...children,
        ]);
      } finally {
        for (const off of entry.off) off();
        this.locals.delete(ref);
        this.peer.notify(ref, 'released', {});
      }
    });
    return entry.closing;
  }
  private releaseOutgoing(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (integer(v.ref) && typeof v.kind === 'string' && v.state && Array.isArray(v.methods)) {
      void this.release(v.ref).catch(() => undefined);
      return;
    }
    for (const child of Object.values(v)) this.releaseOutgoing(child);
  }
  private async releaseIncoming(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (integer(v.ref) && typeof v.kind === 'string' && v.state && Array.isArray(v.methods)) {
      const remote = this.remotes.get(v.ref);
      if (remote) this.closeRemote(remote);
      await this.peer.call(v.ref, 'close', null);
      return;
    }
    await Promise.all(Object.values(v).map((child) => this.releaseIncoming(child)));
  }
  private orphan(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (integer(v.ref) && typeof v.kind === 'string' && v.state && Array.isArray(v.methods)) {
      this.early.delete(v.ref);
      this.recountEarly();
      void this.peer.call(v.ref, 'close', null).catch(() => undefined);
      return;
    }
    for (const child of Object.values(v)) this.orphan(child);
  }
  private async dispose(): Promise<void> {
    for (const remote of this.remotes.values()) {
      remote.ready?.reject(failure('disconnected'));
      remote.done?.reject(failure('disconnected'));
      this.closeRemote(remote);
    }
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
