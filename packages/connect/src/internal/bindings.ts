import type {
  Command,
  Commands,
  DataEvent,
  FieldSelection,
  Input,
  Model,
  MonitorOptions,
  Routine,
  Schema,
} from '@latkit/model';
import { validateSchema, validateDataEvent, validateQuery } from '@latkit/model';
import type { Peer, Reply } from './peer.js';
import { aborted, errorValue, failure, interrupt } from './errors.js';
import { record, text, array, integer } from './validation.js';
import { bytes, readable } from './streams.js';
interface Reference {
  ref: number;
  kind: 'stream';
  state: Record<string, unknown>;
  credit?: number;
}
interface Local {
  iterator: AsyncIterator<unknown>;
  controller: AbortController;
  credit: number;
  pulling?: boolean;
}
interface Remote {
  reference: Reference;
  closed: boolean;
  dispose?: () => void;
}

/** Only live subscriptions and command file streams cross the connection. */
export class Bindings {
  private nextRef = 1;
  private locals = new Map<number, Local>();
  private remotes = new Map<number, Remote>();
  constructor(
    readonly peer: Peer,
    private readonly root?: { model: Model; commands?: Commands },
  ) {
    peer.invoke = this.invoke.bind(this);
    peer.orphan = this.orphan.bind(this);
    peer.dispose = this.dispose.bind(this);
  }
  async connectRoot(): Promise<Model & { readonly commands?: Commands }> {
    const result = record(await this.peer.call(0, 'acquire', null));
    const name = text(result.name);
    if (validateSchema(result.schema).length)
      throw failure('invalid-input', 'Invalid model schema.');
    const schema = result.schema as Schema;
    const model: Model & { commands?: Commands } = {
      name,
      schema,
      monitor: (fields, options = {}) => this.monitor(schema, fields, options),
    };
    if (result.routines !== undefined) {
      const routines = array(result.routines);
      for (const value of routines) {
        const routine = record(value);
        text(routine.id);
        text(routine.label);
        array(routine.parameters);
      }
      model.commands = {
        routines: routines as unknown as readonly Routine[],
        run: async (command, options = {}) => {
          aborted(options.signal);
          const references = new Set<number>();
          try {
            return (await this.peer.call(
              0,
              'run',
              this.encodeCommand(command, references),
              options.signal,
            )) as Awaited<ReturnType<Commands['run']>>;
          } finally {
            await Promise.allSettled([...references].map((ref) => this.release(ref)));
          }
        },
      };
    }
    return model;
  }
  private checkLimit(_stream = false): void {
    if (this.locals.size >= Math.min(this.peer.bounds.maxReferences, this.peer.bounds.maxStreams))
      throw failure('resource-limit', 'Stream limit exceeded.');
  }
  private exportStream(
    iterator: AsyncIterator<unknown>,
    controller = new AbortController(),
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
      iterator,
      controller,
      credit,
    });
    return { ref, kind: 'stream', state: {}, credit };
  }
  private descriptor(value: unknown): Reference {
    const r = record(value);
    if (!integer(r.ref) || r.ref === 0 || r.kind !== 'stream')
      throw failure('invalid-input', 'Invalid stream reference.');
    if (this.remotes.size >= this.peer.bounds.maxReferences)
      throw failure('resource-limit', 'Stream limit exceeded.');
    return r as unknown as Reference;
  }
  private encodeInput(input: Input, references: Set<number>): unknown {
    const stream = this.exportStream(
      bytes(input.stream, this.peer.blockBytes)[Symbol.asyncIterator](),
    );
    references.add(stream.ref);
    return {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      stream,
    };
  }
  private decodeInput(
    value: unknown,
    streams: AsyncIterableIterator<unknown>[],
    signal?: AbortSignal,
  ): Input {
    const input = record(value);
    const stream = this.importStream(input.stream, signal);
    streams.push(stream);
    return {
      ...(input.name === undefined ? {} : { name: text(input.name) }),
      ...(input.mediaType === undefined ? {} : { mediaType: text(input.mediaType) }),
      stream: readable(stream),
    };
  }
  private encodeCommand(command: Command, references: Set<number>): unknown {
    const encode = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(encode)
        : value && typeof value === 'object'
          ? this.encodeInput(value as Input, references)
          : value;
    return {
      routine: command.routine,
      values: Object.fromEntries(
        Object.entries(command.values).map(([key, value]) => [key, encode(value)]),
      ),
    };
  }
  private decodeCommand(
    value: unknown,
    streams: AsyncIterableIterator<unknown>[],
    signal?: AbortSignal,
  ): Command {
    const command = record(value);
    const decode = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(decode)
        : v && typeof v === 'object'
          ? this.decodeInput(v, streams, signal)
          : v;
    return {
      routine: text(command.routine),
      values: Object.fromEntries(
        Object.entries(record(command.values)).map(([key, value]) => [key, decode(value)]),
      ) as Command['values'],
    };
  }
  private importStream(value: unknown, signal?: AbortSignal): AsyncIterableIterator<unknown> {
    const reference = this.descriptor(value);
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
    const remote: Remote = { reference, closed: false };
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
  private monitor(
    schema: Schema,
    fields: readonly FieldSelection[],
    options: MonitorOptions,
  ): AsyncIterableIterator<DataEvent> {
    const selected = selections(schema, fields);
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    // Start now, so delaying the first pull does not change the subscription boundary.
    const started = this.peer
      .call(0, 'monitor', { fields, maxBlockBytes: options.maxBlockBytes }, signal)
      .then((value) => {
        try {
          return this.importStream(value, signal);
        } catch (error) {
          this.orphan(value);
          throw error;
        }
      });
    void started.catch(() => {});
    let ended = false,
      pulling = false;
    let version: string | undefined;
    const close = async (): Promise<IteratorResult<DataEvent>> => {
      if (!ended) {
        ended = true;
        controller.abort();
        try {
          await (await started).return?.();
        } catch {
          /* Setup failure has no live stream. */
        }
      }
      return { done: true, value: undefined };
    };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        aborted(options.signal);
        if (ended) return { done: true, value: undefined };
        if (pulling) throw failure('busy', 'Concurrent pulls are unsupported.');
        pulling = true;
        try {
          const result = await (await started).next();
          if (result.done) {
            if (version !== undefined)
              throw failure('invalid-input', 'Incomplete data transaction.');
            ended = true;
            return { done: true, value: undefined };
          }
          const issues = validateDataEvent(schema, result.value, options);
          if (issues.length) throw failure('invalid-input', issues[0].message);
          const event = result.value as DataEvent;
          if (
            event.kind === 'data' &&
            Object.keys(event.block.columns).some(
              (field) => !selected.get(event.block.index.type)?.has(field),
            )
          )
            throw failure('invalid-input', 'Publication contains an unselected field.');
          if (event.kind === 'begin') {
            if (version !== undefined) throw failure('invalid-input', 'Nested data transaction.');
            version = event.version;
          } else {
            if (event.version !== version)
              throw failure('conflict', 'Inconsistent data transaction.');
            if (event.kind === 'end') version = undefined;
          }
          return { done: false, value: event };
        } catch (error) {
          await close();
          throw error;
        } finally {
          pulling = false;
        }
      },
      return: close,
      throw: async (error) => {
        await close();
        throw errorValue(error);
      },
    };
  }
  private async invoke(
    ref: number,
    method: string,
    args: unknown,
    signal: AbortSignal,
    credit: number,
  ): Promise<Reply> {
    aborted(signal);
    if (method === 'close' && ref !== 0) {
      await this.release(ref);
      return { value: null };
    }
    const entry = this.locals.get(ref);
    if (ref !== 0 && !entry) throw failure('closed', 'Stream is closed.');
    if (ref !== 0) {
      if (method !== 'next' || !credit || credit < entry!.credit!)
        throw failure('invalid-input', 'Missing pull credit.');
      if (entry!.pulling) throw failure('busy');
      entry!.pulling = true;
      const abort = (): void => {
        entry!.controller.abort();
        void this.release(ref).catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await interrupt(Promise.resolve(entry!.iterator!.next()), signal);
        if (result.done) await this.release(ref);
        return {
          value: { done: result.done === true, value: result.value as unknown },
        };
      } finally {
        entry!.pulling = false;
        signal.removeEventListener('abort', abort);
      }
    }
    if (!this.root) throw failure('unsupported', 'No model is served.');
    if (method === 'acquire')
      return {
        value: {
          name: this.root.model.name,
          schema: this.root.model.schema,
          ...(this.root.commands ? { routines: this.root.commands.routines } : {}),
        },
      };
    if (method === 'monitor') {
      this.checkLimit();
      const request = record(args);
      if (
        request.maxBlockBytes !== undefined &&
        (!integer(request.maxBlockBytes) || request.maxBlockBytes < 1)
      )
        throw failure('invalid-input', 'Invalid block limit.');
      const fields = array(request.fields) as unknown as readonly FieldSelection[];
      selections(this.root.model.schema, fields);
      const controller = new AbortController();
      const bound = Math.min(this.peer.blockBytes, Number(request.maxBlockBytes ?? Infinity));
      const iterator = this.root.model
        .monitor(fields, { signal: controller.signal, maxBlockBytes: bound })
        [Symbol.asyncIterator]();
      const descriptor = this.exportStream(iterator, controller, bound);
      return { value: descriptor, discard: () => this.release(descriptor.ref) };
    }
    if (method === 'run' && this.root.commands) {
      const streams: AsyncIterableIterator<unknown>[] = [];
      try {
        return {
          value: await this.root.commands.run(this.decodeCommand(args, streams, signal), {
            signal,
          }),
        };
      } finally {
        await Promise.allSettled(streams.map((stream) => Promise.resolve(stream.return?.())));
      }
    }
    throw failure('unsupported', 'Unknown capability.');
  }
  private release(ref: number): Promise<void> {
    const entry = this.locals.get(ref);
    if (!entry) return Promise.resolve();
    this.locals.delete(ref);
    entry.controller.abort();
    void Promise.resolve(entry.iterator.return?.()).catch(() => {});
    return Promise.resolve();
  }
  private orphan(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (integer(v.ref) && v.kind === 'stream') {
      void this.peer.call(v.ref, 'close', null).catch(() => {});
      return;
    }
    for (const child of Object.values(v)) this.orphan(child);
  }
  private async dispose(): Promise<void> {
    for (const remote of this.remotes.values()) {
      remote.closed = true;
      remote.dispose?.();
    }
    this.remotes.clear();
    await Promise.allSettled([...this.locals.keys()].map((ref) => this.release(ref)));
  }
}

/** Validate the subscription independently of the provider and track its selected columns. */
function selections(schema: Schema, fields: readonly FieldSelection[]): Map<string, Set<string>> {
  const selected = new Map<string, Set<string>>();
  for (const value of array(fields)) {
    const field = record(value),
      from = text(field.from),
      select = array(field.select).map(text);
    const sampled = select.some((name) => schema.types[from]?.fields[name]?.sampled);
    const issues = validateQuery(schema, {
      kind: 'rows',
      from,
      select,
      ...(field.rows === undefined ? {} : { rows: field.rows }),
      ...(sampled ? { at: 0 } : {}),
    });
    if (issues.length) throw failure('invalid-input', issues[0].message);
    const names = selected.get(from) ?? new Set<string>();
    for (const name of select) names.add(name);
    selected.set(from, names);
  }
  return selected;
}
