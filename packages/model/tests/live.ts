import {
  createData,
  read,
  validateQuery,
  type Model,
  type Schema,
  type Commands,
  type DataEvent,
  type DataPatch,
  type FieldSelection,
  type MonitorOptions,
} from '../src/index.js';
const failure = (code: string) => Object.assign(new Error(code), { code });
interface Subscription {
  send(event: DataEvent): Promise<void>;
  close(): void;
  fields: readonly FieldSelection[];
  bound: number;
}
/** Test producer with one in-flight value per subscriber; it has no data store or replay. */
export class LiveModel implements Model {
  readonly name = 'Live data';
  readonly subscribers = new Set<Subscription>();
  readonly schema: Schema = {
    limits: { maxBlockBytes: 65536 },
    axis: { name: 'time' },
    types: {
      Node: { fields: { value: { type: 'float64' }, output: { type: 'float64', sampled: true } } },
    },
  };
  readonly commands: Commands = {
    routines: [{ id: 'echo', label: 'Echo', parameters: [] }],
    run: async (command, options = {}) => {
      options.signal?.throwIfAborted();
      return { routine: command.routine };
    },
  };
  monitor(
    fields: readonly FieldSelection[],
    options: MonitorOptions = {},
  ): AsyncIterableIterator<DataEvent> {
    const bound = Math.min(options.maxBlockBytes ?? Infinity, this.schema.limits.maxBlockBytes);
    if (!Number.isSafeInteger(bound) || bound < 1) throw failure('invalid-input');
    for (const field of fields) {
      const sampled = field.select.some(
        (name) => this.schema.types[field.from]?.fields[name]?.sampled,
      );
      if (
        validateQuery(this.schema, { ...field, kind: 'rows', ...(sampled ? { at: 0 } : {}) }).length
      )
        throw failure('invalid-input');
    }
    let pending:
      | { resolve(value: IteratorResult<DataEvent>): void; reject(reason: unknown): void }
      | undefined;
    let queued: DataEvent | undefined;
    let consumed: (() => void) | undefined;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      queued = undefined;
      consumed?.();
      consumed = undefined;
      pending?.resolve({ done: true, value: undefined });
      pending = undefined;
      this.subscribers.delete(sub);
      options.signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      const waiting = pending;
      pending = undefined;
      finish();
      waiting?.reject(failure('aborted'));
    };
    const sub: Subscription = {
      fields,
      bound,
      close: finish,
      send: async (event) => {
        if (closed) return;
        if (queued) throw failure('resource-limit');
        if (pending) {
          const resolve = pending.resolve;
          pending = undefined;
          resolve({ done: false, value: event });
          return;
        }
        queued = event;
        await new Promise<void>((resolve) => {
          consumed = resolve;
        });
      },
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    else this.subscribers.add(sub);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (options.signal?.aborted) return Promise.reject(failure('aborted'));
        if (closed) return Promise.resolve({ done: true, value: undefined });
        if (pending) return Promise.reject(failure('busy'));
        if (queued) {
          const value = queued;
          queued = undefined;
          consumed?.();
          consumed = undefined;
          return Promise.resolve({ done: false, value });
        }
        return new Promise((resolve, reject) => {
          pending = { resolve, reject };
        });
      },
      return: () => {
        finish();
        return Promise.resolve({ done: true, value: undefined });
      },
      throw: (error) => {
        finish();
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    };
  }
  async publish(patches: readonly DataPatch[], version = 'v1'): Promise<void> {
    await Promise.all(
      [...this.subscribers].map(async (sub) => {
        await sub.send({ kind: 'begin', version, initial: false });
        for (const patch of patches) {
          const data = createData(this.schema, version, [patch]);
          for (const selection of sub.fields) {
            if (selection.from !== patch.index.type) continue;
            const select = selection.select.filter((field) => field in patch.columns);
            if (!select.length) continue;
            const query =
              patch.kind === 'samples'
                ? {
                    ...selection,
                    select,
                    kind: 'samples' as const,
                    window: {
                      kind: 'frames' as const,
                      offset: patch.firstFrame,
                      count: patch.coordinates.length,
                    },
                  }
                : { ...selection, select, kind: 'rows' as const };
            for await (const block of read(data, query, { maxBlockBytes: sub.bound - 128 })) {
              if (block.kind === 'schema') continue;
              const delivered: DataPatch =
                block.kind === 'rows'
                  ? { kind: 'rows', index: block.index, rows: block.rows, columns: block.columns }
                  : {
                      kind: 'samples',
                      index: block.index,
                      rows: block.rows,
                      firstFrame: block.firstFrame,
                      coordinates: block.coordinates,
                      columns: block.columns,
                    };
              await sub.send({ kind: 'data', version, patch: delivered });
            }
          }
        }
        await sub.send({ kind: 'end', version });
      }),
    );
  }
  end(): void {
    for (const sub of [...this.subscribers]) sub.close();
  }
}
export function inputPatch(count = 4): DataPatch {
  const values = Float64Array.from({ length: count }, (_, i) => (i % 1009) - 504);
  return {
    kind: 'rows',
    index: { source: 'fixture', type: 'Node', version: 'rows1' },
    rows: { kind: 'range', offset: 0, count },
    columns: { value: { kind: 'numeric', offset: 0, length: count, values } },
  };
}
export async function transaction(stream: AsyncIterable<DataEvent>): Promise<DataEvent[]> {
  const events: DataEvent[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    const result = await iterator.next();
    if (result.done) throw new Error('Transaction ended early');
    events.push(result.value);
    if (result.value.kind === 'end') return events;
  }
}
