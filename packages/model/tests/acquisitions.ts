/** Native fixture acquisition management; deliberately not part of the public package. */
import type {
  Recording,
  Queryable,
  QueryOptions,
  RetainOptions,
  RequestOptions,
  Update,
  RecordingOutcome,
  Query,
  QueryHeader,
  QueryBlock,
  RowsQuery,
  RowsBlock,
  SamplesQuery,
  SamplesBlock,
  EndpointsQuery,
  EndpointsBlock,
  LinksQuery,
  LinksBlock,
  AggregateQuery,
  AggregateBlock,
} from '../src/index.js';
import { failure } from './source.js';
import { deferred } from './scale/store.js';
export class Recordings {
  private entries = new Map<string, { source: Recording; handles: Set<RecordingAcquisition> }>();
  constructor(private readonly changed: (delta: number) => void = () => undefined) {}
  add<S extends Recording>(source: S): RecordingAcquisition<S> {
    if (this.entries.has(source.id)) throw failure('conflict');
    this.entries.set(source.id, { source, handles: new Set() });
    return this.acquire(source.id) as RecordingAcquisition<S>;
  }
  acquire(id: string, options?: RequestOptions): RecordingAcquisition {
    if (options?.signal?.aborted) throw failure('aborted');
    const entry = this.entries.get(id);
    if (!entry) throw failure('closed');
    const handle = new RecordingAcquisition(entry.source, async () => {
      entry.handles.delete(handle);
      this.changed(-1);
      if (!entry.handles.size) {
        this.entries.delete(id);
        await entry.source.close();
      }
    });
    entry.handles.add(handle);
    this.changed(1);
    return handle;
  }
  async close(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].flatMap((e) => [...e.handles].map((h) => h.close())),
    );
  }
}
export class RecordingAcquisition<S extends Recording = Recording> implements Recording {
  private closed = false;
  private closing?: Promise<void>;
  private controller = new AbortController();
  private listeners = new Set<(change: Update) => void>();
  private bound = deferred();
  private completed = deferred<RecordingOutcome>();
  private off: () => void;
  readonly ready = this.bound.promise;
  readonly done = this.completed.promise;
  constructor(
    readonly source: S,
    private readonly release: () => Promise<void>,
  ) {
    this.off = source.on('change', (change) => {
      for (const listener of this.listeners) listener(change);
    });
    void source.ready.then(this.bound.resolve, this.bound.reject);
    void source.done.then(this.completed.resolve, this.completed.reject);
  }
  get id() {
    return this.source.id;
  }
  get modelId() {
    return this.source.modelId;
  }
  get documentId() {
    return this.source.documentId;
  }
  get documentVersion() {
    return this.source.documentVersion;
  }
  get scope() {
    return this.source.scope;
  }
  get status() {
    return this.source.status;
  }
  get fields() {
    return this.source.fields;
  }
  get axis() {
    return this.source.axis;
  }
  get firstFrame() {
    return this.source.firstFrame;
  }
  get frameCount() {
    return this.source.frameCount;
  }
  get range() {
    return this.source.range;
  }
  get error() {
    return this.source.error;
  }
  get version() {
    return this.source.version;
  }
  private options<T extends RequestOptions>(options?: T): T & { signal: AbortSignal } {
    if (this.closed) throw failure('closed');
    return {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, this.controller.signal])
        : this.controller.signal,
    } as T & { signal: AbortSignal };
  }
  async describe(options?: RequestOptions) {
    return this.source.describe(this.options(options));
  }
  async retain(options?: RetainOptions): Promise<Queryable> {
    return this.source.retain(this.options(options));
  }
  query(query: RowsQuery, options?: QueryOptions): AsyncIterable<QueryHeader | RowsBlock>;
  query(query: SamplesQuery, options?: QueryOptions): AsyncIterable<QueryHeader | SamplesBlock>;
  query(query: EndpointsQuery, options?: QueryOptions): AsyncIterable<QueryHeader | EndpointsBlock>;
  query(query: LinksQuery, options?: QueryOptions): AsyncIterable<QueryHeader | LinksBlock>;
  query(query: AggregateQuery, options?: QueryOptions): AsyncIterable<QueryHeader | AggregateBlock>;
  query(query: Query, options?: QueryOptions): AsyncIterable<QueryHeader | QueryBlock>;
  query(query: Query, options?: QueryOptions): AsyncIterable<QueryHeader | QueryBlock> {
    return {
      [Symbol.asyncIterator]: () =>
        this.source.query(query, this.options(options))[Symbol.asyncIterator](),
    };
  }
  on(_event: 'change', listener: (change: Update) => void): () => void {
    this.options();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async commands(page: Parameters<Recording['commands']>[0], options?: RequestOptions) {
    return this.source.commands(page, this.options(options));
  }
  async diagnostics(page: Parameters<Recording['diagnostics']>[0], options?: RequestOptions) {
    return this.source.diagnostics(page, this.options(options));
  }
  async export(options?: RequestOptions) {
    return this.source.export(this.options(options));
  }
  async stop(): Promise<void> {
    this.options();
    await this.source.stop();
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.controller.abort();
      this.off();
      // Propagate already settled producer promises before rejecting this acquisition's waits.
      await Promise.resolve();
      this.bound.reject(failure('closed'));
      this.completed.reject(failure('closed'));
      for (const listener of this.listeners) listener({ kind: 'closed' });
      this.listeners.clear();
      await this.release();
    })());
  }
}
