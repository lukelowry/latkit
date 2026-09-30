/** Test implementations, deliberately not exported by the package. */
import type {
  Axis,
  CallOptions,
  Change,
  Command,
  CommandEntry,
  CommandEvent,
  CommandResult,
  Diagnostic,
  Document,
  Edit,
  Export,
  Failure,
  ModelService,
  OpenInput,
  Resource,
  ResourceInfo,
  ResourceWrite,
  SavedDocument,
  SaveOptions,
  ReloadOptions,
  Update,
  Model,
  MonitorConfig,
  QueryBlock,
  QueryHeader,
  RecordedFields,
  Recording,
  RecordingOutcome,
  RecordingStatus,
  RequestOptions,
  Routine,
  RowAxis,
  Schema,
} from '../src/index.js';
import { Source, axisLength, failure, selectRows } from './source.js';
import type { Frame, Inputs, ReadState } from './source.js';
export { failure } from './source.js';
export const fixtureSchema: Schema = {
  version: 'fixture-schema',
  queries: ['rows', 'aggregate'],
  limits: { maxBlockBytes: 4096 },
  components: {
    Node: {
      operations: ['add', 'set', 'remove'],
      fields: {
        value: { type: 'float64', required: true, writable: true },
        output: { type: 'float64', sampled: true },
        other: { type: 'float64', sampled: true },
      },
    },
  },
  connections: {},
};
const { operations: _operations, ...readNode } = fixtureSchema.components.Node;
const readSchema: Schema = { ...fixtureSchema, components: { Node: readNode } };
export async function collect<B extends QueryBlock>(
  source: AsyncIterable<QueryHeader | B>,
): Promise<B[]> {
  const values: B[] = [];
  for await (const value of source) if (value.kind !== 'schema') values.push(value as B);
  return values;
}
interface DocumentCore {
  id: string;
  state: Inputs;
  counter: number;
  nextId: number;
  handles: Set<FixtureDocument>;
  models: Set<FixtureModel>;
  resource?: Resource;
  saved: SavedDocument | null;
  bytes?: Uint8Array;
  saveQueue: Promise<unknown>;
}
let nextDocument = 0;
export class FixtureDocument extends Source implements Document {
  readonly name = 'Fixture';
  readonly format = 'fixture';
  readonly core: DocumentCore;
  private closed = false;
  private savedListeners = new Set<(saved: SavedDocument) => void>();
  constructor(
    readonly editable = true,
    shared?: FixtureDocument,
  ) {
    super();
    if (shared) this.core = shared.core;
    else {
      const id = 'fixture-document-' + nextDocument++;
      this.core = {
        id,
        state: {
          version: '1',
          index: { document: id, type: 'Node', version: '1' },
          ids: ['n1', 'n2', 'n3', 'n4'],
          values: new Float64Array([1, 2, 3, 4]),
        },
        counter: 1,
        nextId: 5,
        handles: new Set(),
        models: new Set(),
        saved: null,
        saveQueue: Promise.resolve(),
      };
    }
    this.core.handles.add(this);
  }
  get id(): string {
    return this.core.id;
  }
  get version(): string {
    return this.state.version;
  }
  get saved(): SavedDocument | null {
    return this.core.saved;
  }
  get state(): Inputs {
    return this.core.state;
  }
  set state(value: Inputs) {
    this.core.state = value;
  }
  check(): void {
    if (this.closed) throw failure('closed');
  }
  acquire(): FixtureDocument {
    this.check();
    return new FixtureDocument(this.editable, this);
  }
  inputs(): Inputs {
    this.check();
    return this.state;
  }
  stateForRead(): ReadState {
    return {
      inputs: this.inputs(),
      version: this.version,
      schema: this.editable ? fixtureSchema : readSchema,
    };
  }
  override on(event: 'change', listener: (change: Update) => void): () => void;
  override on(event: 'saved', listener: (saved: SavedDocument) => void): () => void;
  override on(
    event: 'change' | 'saved',
    listener: ((change: Update) => void) | ((saved: SavedDocument) => void),
  ): () => void {
    this.check();
    if (event === 'change') return super.on(event, listener as (change: Update) => void);
    const callback = listener as (saved: SavedDocument) => void;
    this.savedListeners.add(callback);
    return () => {
      this.savedListeners.delete(callback);
    };
  }
  private broadcast(update: Update): void {
    for (const handle of this.core.handles) handle.publish(update);
  }
  private changing(): void {
    for (const model of this.core.models) model.changing();
  }
  /** Internal fixture replacement, not a public open operation. */
  async replace(values: Float64Array = new Float64Array([1, 2, 3, 4])): Promise<void> {
    this.check();
    this.changing();
    const version = String(++this.core.counter);
    this.state = {
      version,
      index: { document: this.id, type: 'Node', version },
      ids: Array.from(values, () => 'n' + this.core.nextId++),
      values,
    };
    this.broadcast({ kind: 'replace', version, schemaVersion: fixtureSchema.version });
  }
  async edit(edits: readonly Edit[]): Promise<Change> {
    this.check();
    const old = new Map(this.state.ids.map((id, i) => [id, this.state.values[i]]));
    for (const edit of edits)
      if (edit.kind === 'assert') {
        const exists = old.has(edit.id);
        if (
          edit.exists === false
            ? exists
            : !exists || (edit.values && edit.values.value !== old.get(edit.id))
        )
          throw failure('conflict');
      }
    const draft = new Map(old);
    const created: Record<string, string> = {};
    let nextId = this.core.nextId;
    for (const edit of edits)
      if (edit.kind === 'add-component') {
        if (edit.type !== 'Node' || !edit.as || Object.hasOwn(created, edit.as))
          throw failure('invalid-input');
        Object.defineProperty(created, edit.as, { value: 'n' + nextId++, enumerable: true });
      }
    const resolve = (ref: string | { readonly local: string }): string => {
      if (typeof ref === 'string') return ref;
      if (!Object.hasOwn(created, ref.local)) throw failure('invalid-input');
      return created[ref.local];
    };
    const value = (v: unknown): number => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw failure('invalid-input');
      return v;
    };
    for (const edit of edits) {
      if (edit.kind === 'assert') continue;
      if (edit.kind === 'add-component') draft.set(created[edit.as], value(edit.values.value));
      else if (edit.kind === 'set') {
        const id = resolve(edit.id);
        if (!draft.has(id) || Object.keys(edit.values).some((k) => k !== 'value'))
          throw failure('invalid-input');
        if (Object.hasOwn(edit.values, 'value')) draft.set(id, value(edit.values.value));
      } else if (edit.kind === 'remove')
        for (const ref of edit.ids) {
          if (!draft.delete(resolve(ref))) throw failure('invalid-input');
        }
      else throw failure('unsupported');
    }
    const changed =
      draft.size !== old.size || [...draft].some(([id, value]) => old.get(id) !== value);
    if (changed) {
      this.changing();
      const ids = [...draft.keys()];
      const structure =
        ids.length !== this.state.ids.length || ids.some((id, i) => id !== this.state.ids[i]);
      const version = String(++this.core.counter);
      this.state = {
        version,
        ids,
        values: Float64Array.from(draft.values()),
        index: structure ? { ...this.state.index, version } : this.state.index,
      };
      this.core.nextId = nextId;
      this.broadcast(
        structure
          ? { kind: 'structure', version, indexes: [this.state.index] }
          : { kind: 'data', version, types: ['Node'] },
      );
    }
    return { version: this.version, changed, created };
  }
  async load(resource: Resource, options?: RequestOptions): Promise<void> {
    try {
      if (options?.signal?.aborted) throw failure('aborted');
      const state = await resource.stat(options);
      if (!state) throw failure('invalid-input');
      const bytes = await readBytes(await resource.read({ tag: state.tag }, options));
      const values = decodeValues(bytes);
      await this.replace(values);
      this.core.resource = resource;
      this.core.bytes = bytes;
      this.core.saved = { resource: resource.id, tag: state.tag, version: this.version };
    } catch (error) {
      await resource.close();
      throw error;
    }
  }
  save(options: SaveOptions = {}): Promise<SavedDocument> {
    this.check();
    const pinned = this.state;
    const operation = async (): Promise<SavedDocument> => {
      const resource = options.to?.resource ?? this.core.resource;
      const base = options.to ? options.to.base : (this.saved?.tag ?? null);
      const bytes = new TextEncoder().encode(JSON.stringify([...pinned.values]));
      try {
        this.check();
        if (options.signal?.aborted) throw failure('aborted');
        if (!resource?.write) throw failure('unsupported');
        const old = this.core.bytes;
        const incremental = !options.to && old;
        async function* parts(): AsyncGenerator<import('../src/index.js').WritePart> {
          if (!incremental) {
            yield { kind: 'data', bytes };
            return;
          }
          let prefix = 0;
          while (prefix < old!.length && prefix < bytes.length && old![prefix] === bytes[prefix])
            prefix++;
          let suffix = 0;
          while (
            suffix < old!.length - prefix &&
            suffix < bytes.length - prefix &&
            old![old!.length - 1 - suffix] === bytes[bytes.length - 1 - suffix]
          )
            suffix++;
          if (prefix) yield { kind: 'copy', offset: 0, length: prefix };
          if (bytes.length > prefix + suffix)
            yield { kind: 'data', bytes: bytes.subarray(prefix, bytes.length - suffix) };
          if (suffix) yield { kind: 'copy', offset: old!.length - suffix, length: suffix };
        }
        const state = await resource.write({ base, parts: parts() }, options);
        const previous = this.core.resource;
        this.core.resource = resource;
        this.core.bytes = bytes;
        this.core.saved = { resource: resource.id, tag: state.tag, version: pinned.version };
        if (previous && previous !== resource) await previous.close();
        for (const handle of this.core.handles)
          for (const listener of handle.savedListeners) listener(this.core.saved);
        return this.core.saved;
      } catch (error) {
        if (options.to && resource !== this.core.resource) await resource?.close();
        throw error;
      }
    };
    const result = this.core.saveQueue.then(operation);
    this.core.saveQueue = result.catch(() => undefined);
    return result;
  }
  async reload(options: ReloadOptions = {}): Promise<Change> {
    this.check();
    if (this.saved?.version !== this.version && !options.discardChanges) throw failure('conflict');
    const resource = this.core.resource;
    if (!resource) throw failure('unsupported');
    const initialVersion = this.version;
    const baseline = this.saved;
    const info = await resource.stat(options);
    if (!info) throw failure('invalid-input');
    const bytes = await readBytes(await resource.read({ tag: info.tag }, options));
    const values = decodeValues(bytes);
    this.check();
    if (options.signal?.aborted) throw failure('aborted');
    if (
      this.version !== initialVersion ||
      this.core.resource !== resource ||
      this.saved !== baseline
    )
      throw failure('conflict');
    await this.replace(values);
    this.core.bytes = bytes;
    this.core.saved = { resource: resource.id, tag: info.tag, version: this.version };
    for (const handle of this.core.handles)
      for (const listener of handle.savedListeners) listener(this.core.saved);
    return { version: this.version, changed: true, created: {} };
  }
  async attach(resource: Resource, options?: RequestOptions): Promise<void> {
    try {
      this.check();
      if (options?.signal?.aborted) throw failure('aborted');
      if (resource.id !== this.saved?.resource) throw failure('conflict');
      const old = this.core.resource;
      this.core.resource = resource;
      if (old !== resource) await old?.close();
    } catch (error) {
      await resource.close();
      throw error;
    }
  }
  async export(): Promise<Export> {
    this.check();
    const version = this.version;
    const bytes = new TextEncoder().encode(JSON.stringify([...this.state.values]));
    return { version, mediaType: 'application/json', stream: byteStream(bytes) };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelReads();
    this.core.handles.delete(this);
    this.publish({ kind: 'closed' });
    this.savedListeners.clear();
    if (!this.core.handles.size) await this.core.resource?.close();
  }
}
export async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      size += result.value.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
function decodeValues(bytes: Uint8Array): Float64Array {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number' && Number.isFinite(v)))
    throw failure('invalid-input');
  return Float64Array.from(value as number[]);
}

export class FixtureRecording extends Source implements Recording {
  readonly id: string;
  readonly documentId: string;
  readonly scope: MonitorConfig['scope'];
  status: RecordingStatus = 'armed';
  documentVersion: string | null = null;
  fields: readonly RecordedFields[] | null = null;
  axis: Axis | null = null;
  firstFrame = 0;
  frameCount = 0;
  error: Failure | null = null;
  version = '0';
  readonly ready: Promise<void>;
  readonly done: Promise<RecordingOutcome>;
  private bound!: () => void;
  private unbound!: (error: Failure) => void;
  private settle!: (outcome: RecordingOutcome) => void;
  private pinned: Inputs | null = null;
  private frames: Frame[] = [];
  private entries: CommandEntry[] = [];
  private coverage = new Map<string, RowAxis>();
  private schema: Schema | null = null;
  private firstCoordinate?: number;
  private evictedThrough?: number;
  liveCommand = false;
  constructor(
    readonly config: MonitorConfig,
    readonly model: FixtureModel,
  ) {
    super();
    this.scope = config.scope;
    this.id = 'capture-' + model.recordings.length;
    this.documentId = model.document.id;
    this.ready = new Promise((resolve, reject) => {
      this.bound = resolve;
      this.unbound = reject;
    });
    void this.ready.catch(() => undefined);
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
  }
  get range(): readonly [number, number] | null {
    return this.frames.length
      ? [this.frames[0].coordinate, this.frames[this.frames.length - 1].coordinate]
      : null;
  }
  inputs(): Inputs {
    if (this.status === 'closed') throw failure('closed');
    if (!this.pinned) throw failure('busy');
    return this.pinned;
  }
  stateForRead(): ReadState {
    return {
      inputs: this.inputs(),
      version: this.version,
      schema: this.schema!,
      frames: this.frames.slice(),
      firstFrame: this.firstFrame,
      frameCount: this.frameCount,
      firstCoordinate: this.firstCoordinate,
      evictedThrough: this.evictedThrough,
      coverage: this.coverage,
    };
  }
  bind(inputs: Inputs, routine?: Routine): void {
    try {
      if (routine && !routine.monitoring?.includes(this.scope.kind)) throw failure('unsupported');
      if (!this.config.fields.length) throw failure('invalid-input');
      const coverage = new Map<string, RowAxis>();
      const fields: RecordedFields[] = [];
      for (const selection of this.config.fields) {
        if (selection.from !== 'Node' || !selection.select.length) throw failure('invalid-input');
        const rows = selectRows(inputs, selection.rows);
        for (const field of selection.select) {
          if (!fixtureSchema.components.Node.fields[field]?.sampled || coverage.has(field))
            throw failure('invalid-input');
          coverage.set(field, rows);
        }
        fields.push({ from: selection.from, select: selection.select, index: inputs.index, rows });
      }
      const axis = { name: 'time', unit: 's' };
      const schema: Schema = {
        ...readSchema,
        version: 'recording-' + this.id,
        queries: ['rows', 'samples', 'aggregate'],
        axis,
        components: {
          Node: {
            fields: Object.fromEntries(
              Object.entries(readNode.fields).filter(
                ([field, definition]) => !definition.sampled || coverage.has(field),
              ),
            ),
          },
        },
      };
      this.pinned = inputs;
      this.documentVersion = inputs.version;
      this.fields = fields;
      this.coverage = coverage;
      this.axis = axis;
      this.schema = schema;
      this.liveCommand = routine?.mode === 'live';
      this.status = 'monitoring';
      this.version = '1';
      this.bound();
      this.publish({ kind: 'status' });
    } catch (error) {
      this.fail(error as Failure);
    }
  }
  observe(entry: CommandEntry): void {
    if (this.status !== 'monitoring') return;
    const previous = this.entries.findIndex((item) => item.id === entry.id);
    if (previous >= 0) this.entries[previous] = entry;
    else this.entries.push(entry);
    this.version = String(Number(this.version) + 1);
    this.publish({ kind: 'commands', version: this.version });
  }
  append(frame: Frame): void {
    if (this.status !== 'monitoring') return;
    if (this.range && frame.coordinate < this.range[1]) {
      this.fail(failure('invalid-input'));
      return;
    }
    const bytes =
      8 + [...this.coverage.values()].reduce((sum, rows) => sum + axisLength(rows) * 8, 0);
    const config = this.config.retain;
    const capacity = Math.min(
      Math.floor(config.bytes / bytes),
      config.kind === 'rolling' ? (config.frames ?? Infinity) : Infinity,
    );
    if (!capacity || (config.kind === 'all' && this.frames.length >= capacity)) {
      if (config.onLimit === 'fail') this.fail(failure('resource-limit'));
      else this.finish('limit');
      return;
    }
    const before = this.firstFrame;
    if (config.kind === 'rolling')
      while (this.frames.length >= capacity) {
        this.evictedThrough = this.frames.shift()!.coordinate;
        this.firstFrame++;
      }
    this.firstCoordinate ??= frame.coordinate;
    this.frames.push({
      coordinate: frame.coordinate,
      values: Object.fromEntries(
        [...this.coverage.keys()].map((field) => [field, frame.values[field]]),
      ),
    });
    this.frameCount++;
    this.version = String(Number(this.version) + 1);
    if (before !== this.firstFrame)
      this.publish({ kind: 'evict', version: this.version, beforeFrame: this.firstFrame });
    this.publish({
      kind: 'append',
      version: this.version,
      frames: { offset: this.frameCount - 1, count: 1 },
    });
  }
  finish(reason: Extract<RecordingOutcome, { status: 'stopped' }>['reason']): void {
    if (this.status !== 'armed' && this.status !== 'monitoring') return;
    if (!this.pinned) this.unbound(failure('aborted'));
    this.status = 'stopped';
    this.settle({ status: 'stopped', reason });
    this.publish({ kind: 'status' });
  }
  fail(error: Failure): void {
    if (this.status !== 'armed' && this.status !== 'monitoring') return;
    if (!this.pinned) this.unbound(error);
    this.error = error;
    this.status = 'failed';
    this.settle({ status: 'failed', error });
    this.publish({ kind: 'status' });
  }
  async commands(page: {
    offset?: number;
    limit: number;
  }): Promise<{ version: string; items: readonly CommandEntry[]; total: number }> {
    if (this.status === 'closed') throw failure('closed');
    if (
      !Number.isSafeInteger(page.limit) ||
      page.limit <= 0 ||
      !Number.isSafeInteger(page.offset ?? 0) ||
      (page.offset ?? 0) < 0
    )
      throw failure('invalid-input');
    return {
      version: this.version,
      items: this.entries.slice(page.offset ?? 0, (page.offset ?? 0) + page.limit),
      total: this.entries.length,
    };
  }
  async diagnostics(): Promise<{
    version: string;
    items: readonly Diagnostic[];
    firstSequence: null;
    discardedThrough: null;
  }> {
    if (this.status === 'closed') throw failure('closed');
    return { version: this.version, items: [], firstSequence: null, discardedThrough: null };
  }
  async stop(): Promise<void> {
    this.finish('requested');
  }
  async close(): Promise<void> {
    if (this.status === 'closed') return;
    this.finish('closed');
    this.cancelReads();
    this.status = 'closed';
    this.frames = [];
    this.pinned = null;
    this.publish({ kind: 'closed' });
  }
  async export(): Promise<Export> {
    const inputs = this.inputs();
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        inputs: [...inputs.values],
        frames: this.frames.map((frame) => [
          frame.coordinate,
          Object.fromEntries(
            Object.entries(frame.values).map(([field, values]) => [field, [...values]]),
          ),
        ]),
      }),
    );
    return {
      version: this.version,
      mediaType: 'application/vnd.latkit.test+json',
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }
}
interface Work {
  id: string;
  inputs: Inputs;
  command: Command;
  routine: Routine;
  resolve: (result: CommandResult) => void;
  reject: (error: Failure) => void;
  cleanup: () => void;
}
export class FixtureModel implements Model {
  readonly id = 'fixture-' + crypto.randomUUID();
  readonly label = 'Fixture';
  readonly document: FixtureDocument;
  readonly documentId: string;
  readonly routines: readonly Routine[] = [
    { id: 'solve', label: 'Solve', mode: 'isolated', monitoring: ['command'], parameters: [] },
    {
      id: 'adjust',
      label: 'Adjust',
      mode: 'live',
      monitoring: ['command', 'live'],
      parameters: [],
    },
  ];
  readonly recordings: FixtureRecording[] = [];
  readonly work = new Map<string, Work>();
  private used = new Set<string>();
  private closed = false;
  private listeners = new Map<string, Set<(value: unknown) => void>>();
  constructor(
    readonly editable = true,
    document?: FixtureDocument,
  ) {
    this.document = document ? document.acquire() : new FixtureDocument(editable);
    this.documentId = this.document.id;
    this.document.core.models.add(this);
  }
  check(): void {
    if (this.closed) throw failure('closed');
  }
  on(event: 'routines' | 'reset', listener: () => void): () => void;
  on(event: 'command', listener: (event: CommandEvent) => void): () => void;
  on(event: 'diagnostic', listener: (event: Diagnostic) => void): () => void;
  on(event: string, listener: (event: never) => void): () => void {
    const callbacks = this.listeners.get(event) ?? new Set();
    const callback = listener as (event: unknown) => void;
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
    return () => {
      callbacks.delete(callback);
    };
  }
  private emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  async monitor(config: MonitorConfig, options?: RequestOptions): Promise<FixtureRecording> {
    this.check();
    if (options?.signal?.aborted) throw failure('aborted');
    if (config.scope.kind === 'command' && this.used.has(config.scope.id))
      throw failure('conflict');
    const recording = new FixtureRecording(config, this);
    if (config.scope.kind === 'live') {
      recording.bind(this.document.state);
      if (recording.error) throw recording.error;
    }
    this.recordings.push(recording);
    return recording;
  }
  call(command: Command, options: CallOptions = {}): Promise<CommandResult> {
    this.check();
    const id = options.id ?? 'command-' + this.used.size;
    if (this.used.has(id)) return Promise.reject(failure('conflict'));
    this.used.add(id);
    const captures = this.recordings.filter(
      (r) => r.scope.kind === 'command' && r.scope.id === id && r.status === 'armed',
    );
    const routine = this.routines.find((r) => r.id === command.routine);
    if (!routine || options.signal?.aborted) {
      const error = failure(options.signal?.aborted ? 'aborted' : 'invalid-input');
      for (const capture of captures) capture.fail(error);
      return Promise.reject(error);
    }
    const inputs = this.document.state;
    for (const capture of captures) capture.bind(inputs, routine);
    const promise = new Promise<CommandResult>((resolve, reject) => {
      const abort = (): void => this.cancel(id);
      options.signal?.addEventListener('abort', abort, { once: true });
      this.work.set(id, {
        id,
        inputs,
        command,
        routine,
        resolve,
        reject,
        cleanup: () => options.signal?.removeEventListener('abort', abort),
      });
    });
    this.update(id, 'queued');
    return promise;
  }
  start(id: string): void {
    this.update(id, 'running');
  }
  complete(id: string, multiplier = 1, error?: Failure): void {
    const work = this.work.get(id);
    if (!work) throw new Error('Unknown fixture command');
    const output = work.inputs.values.map((value) => value * multiplier);
    const frame = { coordinate: 0, values: { output, other: output.map((value) => value * 10) } };
    for (const capture of this.captures(id)) capture.append(frame);
    this.update(id, error ? 'failed' : 'complete', error);
    for (const capture of this.captures(id))
      if (capture.scope.kind === 'command') capture.finish('command-finished');
    this.work.delete(id);
    work.cleanup();
    if (error) work.reject(error);
    else work.resolve({});
  }
  cancel(id: string): void {
    const work = this.work.get(id);
    if (!work) return;
    this.update(id, 'cancelled');
    for (const capture of this.captures(id))
      if (capture.scope.kind === 'command') capture.finish('command-finished');
    this.work.delete(id);
    work.cleanup();
    work.reject(failure('aborted'));
  }
  private captures(id: string): FixtureRecording[] {
    return this.recordings.filter((r) =>
      r.scope.kind === 'command' ? r.scope.id === id : this.work.get(id)?.routine.mode === 'live',
    );
  }
  private update(id: string, status: CommandEntry['status'], error?: Failure): void {
    const work = this.work.get(id);
    if (!work) return;
    const detail =
      status === 'complete'
        ? ({ status, result: {} } as const)
        : status === 'failed'
          ? ({ status, error: error ?? failure('internal') } as const)
          : ({ status } as const);
    for (const capture of this.captures(id))
      capture.observe({
        id,
        routine: work.command.routine,
        values: {},
        documentVersion: work.inputs.version,
        firstFrame: 0,
        endFrame: capture.frameCount,
        ...detail,
      });
    this.emit('command', { id, documentVersion: work.inputs.version, ...detail, kind: status });
  }
  live(coordinate: number): void {
    this.check();
    const output = this.document.state.values.map((value) => value + coordinate);
    const frame = { coordinate, values: { output, other: output.map((value) => value * 10) } };
    for (const capture of this.recordings) if (capture.scope.kind === 'live') capture.append(frame);
  }
  changing(): void {
    for (const capture of this.recordings)
      if (capture.scope.kind === 'live' || capture.liveCommand) capture.finish('document-changed');
    for (const [id, work] of this.work) if (work.routine.mode === 'live') this.cancel(id);
  }
  async reset(): Promise<void> {
    this.check();
    for (const capture of this.recordings) capture.finish('reset');
    for (const id of this.work.keys()) this.cancel(id);
    for (const capture of this.recordings) await capture.close();
    this.emit('reset');
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.document.cancelReads();
    for (const capture of this.recordings) capture.finish('closed');
    for (const id of this.work.keys()) this.cancel(id);
    for (const capture of this.recordings) await capture.close();
    this.closed = true;
    this.document.core.models.delete(this);
    await this.document.close();
  }
}
/** A hardcoded read-only document needs no factory, engine, catalog, or source path. */
export function readOnlyDocument(): Document {
  const doc = new FixtureDocument(false);
  return {
    id: doc.id,
    name: doc.name,
    get version() {
      return doc.version;
    },
    format: doc.format,
    get saved() {
      return doc.saved;
    },
    close: () => doc.close(),
    describe: doc.describe.bind(doc),
    query: doc.query.bind(doc),
    on: doc.on.bind(doc),
  };
}

export class FixtureService implements ModelService {
  readonly id = 'fixture';
  readonly label = 'Fixture';
  readonly formats = [
    {
      id: 'fixture',
      label: 'Fixture',
      mediaTypes: ['application/json'],
      extensions: ['json'],
      reads: true,
      writes: true,
      creates: true,
    },
  ];
  readonly documents = new Map<string, FixtureDocument>();
  readonly models: FixtureModel[] = [];
  async open(input?: OpenInput, options?: RequestOptions): Promise<Document> {
    const document = new FixtureDocument();
    try {
      if (options?.signal?.aborted) throw failure('aborted');
      if (input?.kind === 'resource') await document.load(input.resource, options);
      else if (input?.kind === 'content')
        await document.replace(decodeValues(await readBytes(input.stream)));
      else if (input && input.kind !== 'empty') throw failure('unsupported');
      this.documents.set(document.id, document);
      return document;
    } catch (error) {
      if (input?.kind === 'resource') await input.resource.close();
      if (input?.kind === 'content' && !input.stream.locked) await input.stream.cancel();
      await document.close();
      throw error;
    }
  }
  private live(id: string): FixtureDocument {
    const original = this.documents.get(id);
    const handle = original && [...original.core.handles][0];
    if (!handle) throw failure('closed');
    return handle;
  }
  async document(id: string): Promise<Document> {
    return this.live(id).acquire();
  }
  async model(id: string): Promise<FixtureModel> {
    const model = new FixtureModel(true, this.live(id));
    this.models.push(model);
    return model;
  }
}
/** Application-side conditional storage, with separate revocable grants. */
export class MemoryFile {
  bytes: Uint8Array | null;
  private revision = 0;
  reads = 0;
  writes: import('../src/index.js').WritePart[][] = [];
  closedGrants = 0;
  writeGate?: Promise<void>;
  constructor(
    readonly id = 'file',
    content: string | null = '[1,2,3,4]',
  ) {
    this.bytes = content === null ? null : new TextEncoder().encode(content);
  }
  get info(): ResourceInfo | null {
    return this.bytes ? { tag: String(this.revision), size: this.bytes.length } : null;
  }
  replace(content: string): void {
    this.bytes = new TextEncoder().encode(content);
    this.revision++;
  }
  grant(writable = true): Resource {
    let closed = false;
    const pending = new Set<AbortController>();
    const check = (options?: RequestOptions): void => {
      if (closed) throw failure('closed');
      if (options?.signal?.aborted) throw failure('aborted');
    };
    return {
      id: this.id,
      name: 'Fixture.json',
      mediaType: 'application/json',
      stat: async (options) => {
        check(options);
        return this.info;
      },
      read: async (request, options) => {
        check(options);
        if (request.tag !== this.info?.tag) throw failure('conflict');
        this.reads++;
        const bytes = this.bytes!;
        const offset = request.range?.offset ?? 0;
        const length = request.range?.length ?? bytes.length;
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          offset + length > bytes.length
        )
          throw failure('invalid-input');
        return byteStream(bytes.subarray(offset, offset + length));
      },
      ...(writable
        ? {
            write: async (
              request: ResourceWrite,
              options?: RequestOptions,
            ): Promise<ResourceInfo> => {
              check(options);
              const controller = new AbortController();
              pending.add(controller);
              const abort = (): void => controller.abort();
              options?.signal?.addEventListener('abort', abort, { once: true });
              try {
                const base = this.bytes;
                const tag = this.info?.tag ?? null;
                if (request.base !== tag) throw failure('conflict');
                const chunks: Uint8Array[] = [];
                const parts: import('../src/index.js').WritePart[] = [];
                for await (const part of request.parts) {
                  check(options);
                  if (controller.signal.aborted) throw failure('aborted');
                  parts.push(part);
                  if (part.kind === 'data') chunks.push(part.bytes.slice());
                  else {
                    if (
                      !base ||
                      !Number.isSafeInteger(part.offset) ||
                      !Number.isSafeInteger(part.length) ||
                      part.offset < 0 ||
                      part.length < 0 ||
                      part.offset + part.length > base.length
                    )
                      throw failure('invalid-input');
                    chunks.push(base.subarray(part.offset, part.offset + part.length));
                  }
                }
                if (this.writeGate)
                  await new Promise<void>((resolve, reject) => {
                    const abort = (): void => {
                      controller.signal.removeEventListener('abort', abort);
                      reject(failure('aborted'));
                    };
                    controller.signal.addEventListener('abort', abort, { once: true });
                    void this.writeGate!.then(() => {
                      controller.signal.removeEventListener('abort', abort);
                      resolve();
                    }, reject);
                  });
                check(options);
                if (controller.signal.aborted) throw failure('aborted');
                if (request.base !== (this.info?.tag ?? null)) throw failure('conflict');
                const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
                let offset = 0;
                for (const chunk of chunks) {
                  bytes.set(chunk, offset);
                  offset += chunk.length;
                }
                this.bytes = bytes;
                this.revision++;
                this.writes.push(parts);
                return this.info!;
              } finally {
                pending.delete(controller);
                options?.signal?.removeEventListener('abort', abort);
              }
            },
          }
        : {}),
      close: async () => {
        if (closed) return;
        closed = true;
        this.closedGrants++;
        for (const controller of pending) controller.abort();
      },
    };
  }
}
