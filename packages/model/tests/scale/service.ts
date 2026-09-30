/** Scale fixture only: native paged inputs and real asynchronous computation, not a production solver. */
import { setImmediate } from 'node:timers/promises';
import type {
  ModelService,
  Document,
  Model,
  Recording,
  OpenInput,
  RequestOptions,
  Edit,
  Change,
  SavedDocument,
  Update,
  Command,
  CommandEvent,
  CommandResult,
  CommandEntry,
  Diagnostic,
  CallOptions,
  MonitorConfig,
  MonitorScope,
  RecordingStatus,
  RecordingOutcome,
  RecordedFields,
  Axis,
  Domain,
  Failure,
  Export,
  RowAxis,
  Routine,
} from '../../src/index.js';
import { RetainedBudget } from '../retention.js';
import { Recordings } from '../acquisitions.js';
import { ScaleSource, schema } from './source.js';
import type { Read, Frame } from './source.js';
import { Store, metrics, deferred, failure, interrupt } from './store.js';
import type { State, Metrics } from './store.js';
interface Core {
  store: Store;
  documents: Set<ScaleDocument>;
  models: Set<ScaleModel>;
  service: ScaleService;
}
export class ScaleService implements ModelService {
  readonly id = 'scale';
  readonly label = 'Paged scale fixture';
  readonly formats = [];
  readonly stats: Metrics = metrics();
  readonly cores = new Map<string, Core>();
  readonly capturesRegistry = new Recordings((delta) => {
    this.stats.acquisitions += delta;
  });
  async recording(id: string, options?: RequestOptions): Promise<Recording> {
    return this.capturesRegistry.acquire(id, options);
  }
  private waiting?: ReturnType<typeof deferred<void>>;
  private held = new Map<Frame, number>();
  constructor(
    readonly rows = 1_000_000,
    readonly pageRows = 8192,
    readonly retention = new RetainedBudget(),
  ) {}
  get gate(): Promise<void> | undefined {
    return this.waiting?.promise;
  }
  pause(paused: boolean): void {
    if (paused) this.waiting ??= deferred();
    else {
      this.waiting?.resolve();
      this.waiting = undefined;
    }
  }
  inspect(): Metrics {
    return { ...this.stats };
  }
  async open(input?: OpenInput, options?: RequestOptions): Promise<Document> {
    if (options?.signal?.aborted || input) {
      if (input?.kind === 'resource') await input.resource.close();
      if (input?.kind === 'content') await input.stream.cancel();
      throw failure(options?.signal?.aborted ? 'aborted' : 'unsupported');
    }
    const id = crypto.randomUUID();
    const core: Core = {
      service: this,
      store: new Store(id, this.rows, this.pageRows, this.stats, this.retention),
      documents: new Set(),
      models: new Set(),
    };
    core.store.onRelease = () => this.release(core);
    core.store.retainFrames = (frames) => {
      for (const frame of frames) this.hold(frame);
      let retained: readonly Frame[] | undefined = frames;
      return () => {
        for (const frame of retained ?? []) this.drop(frame);
        retained = undefined;
      };
    };
    this.cores.set(id, core);
    return new ScaleDocument(core);
  }
  private core(id: string, options?: RequestOptions): Core {
    if (options?.signal?.aborted) throw failure('aborted');
    const core = this.cores.get(id);
    if (!core) throw failure('closed');
    return core;
  }
  async document(id: string, options?: RequestOptions): Promise<Document> {
    return new ScaleDocument(this.core(id, options));
  }
  async model(id: string, options?: RequestOptions): Promise<Model> {
    return new ScaleModel(this.core(id, options));
  }
  release(core: Core): void {
    if (!core.documents.size && !core.models.size && !core.store.retentions) {
      this.cores.delete(core.store.id);
      core.store.clear();
    }
  }
  hold(frame: Frame): void {
    const count = this.held.get(frame) ?? 0;
    this.held.set(frame, count + 1);
    if (!count) {
      this.stats.frameBytes += frame.values.byteLength + 8;
      this.stats.peakFrameBytes = Math.max(this.stats.peakFrameBytes, this.stats.frameBytes);
    }
  }
  drop(frame: Frame): void {
    const count = this.held.get(frame)!;
    if (count === 1) {
      this.held.delete(frame);
      this.stats.frameBytes -= frame.values.byteLength + 8;
    } else this.held.set(frame, count - 1);
  }
}
export class ScaleDocument extends ScaleSource implements Document {
  readonly name = 'Scale';
  readonly format = null;
  readonly saved = null;
  private closed = false;
  constructor(readonly core: Core) {
    super(core.store, () => core.service.gate);
    core.documents.add(this);
    core.service.stats.acquisitions++;
  }
  get id(): string {
    return this.store.id;
  }
  get version(): string {
    return this.store.state.version;
  }
  pin(): Read {
    if (this.closed) throw failure('closed');
    return { state: this.store.state, version: this.version, schema };
  }
  override on(event: 'change', listener: (value: Update) => void): () => void;
  override on(event: 'saved', listener: (value: SavedDocument) => void): () => void;
  override on(
    event: 'change' | 'saved',
    listener: ((value: Update) => void) | ((value: SavedDocument) => void),
  ): () => void {
    this.pin();
    return event === 'saved'
      ? () => undefined
      : super.on('change', listener as (value: Update) => void);
  }
  async edit(edits: readonly Edit[], options?: RequestOptions): Promise<Change> {
    this.pin();
    if (options?.signal?.aborted) throw failure('aborted');
    const changes = new Map<number, number>();
    for (const edit of edits) {
      if (edit.kind !== 'set' && edit.kind !== 'assert') throw failure('unsupported');
      if (typeof edit.id !== 'string') throw failure('invalid-input');
      const row = this.store.row(edit.id);
      if (edit.kind === 'assert') {
        if (edit.exists === false || edit.endpoints) throw failure('conflict');
        for (const [field, value] of Object.entries(edit.values ?? {}))
          if (field !== 'value' || value !== this.store.at(this.store.state, row))
            throw failure('conflict');
      } else
        for (const [field, value] of Object.entries(edit.values)) {
          if (field !== 'value' || typeof value !== 'number' || !Number.isFinite(value))
            throw failure('invalid-input');
          changes.set(row, value);
        }
    }
    const changing = [...changes].some(
      ([row, value]) => value !== this.store.at(this.store.state, row),
    );
    if (changing) for (const model of this.core.models) model.changing();
    const changed = this.store.edit(changes);
    if (changed)
      for (const document of this.core.documents)
        document.publish({ kind: 'data', version: this.version, types: ['Node'] });
    return { version: this.version, changed, created: {} };
  }
  async export(options?: RequestOptions): Promise<Export> {
    return exported(this.store, this.pin(), [], options);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cancel();
    this.publish({ kind: 'closed' });
    this.listeners.clear();
    this.core.documents.delete(this);
    this.core.service.stats.acquisitions--;
    this.core.service.release(this.core);
  }
}
const routines: readonly Routine[] = ['simulate', 'advance'].map((id) => ({
  id,
  label: id,
  mode: id === 'simulate' ? 'isolated' : 'live',
  monitoring: id === 'simulate' ? ['command'] : ['command', 'live'],
  parameters: [
    { id: 'frames', label: 'Frames', type: 'number', required: true },
    { id: 'factor', label: 'Factor', type: 'number', required: true },
  ],
}));
interface Work {
  controller: AbortController;
  mode: Routine['mode'];
  promise: Promise<CommandResult>;
}
export class ScaleModel implements Model {
  readonly id = crypto.randomUUID();
  readonly label = 'Scale computation';
  readonly routines = routines;
  readonly recordings = new Set<ScaleRecording>();
  private used = new Set<string>();
  private work = new Map<string, Work>();
  private listeners = new Map<string, Set<(value: unknown) => void>>();
  private closed = false;
  private resetting = false;
  private closing?: Promise<void>;
  private coordinate = 0;
  constructor(readonly core: Core) {
    core.models.add(this);
    core.service.stats.models++;
  }
  get documentId(): string {
    return this.core.store.id;
  }
  private check(): void {
    if (this.closed) throw failure('closed');
    if (this.resetting) throw failure('busy');
  }
  on(event: 'reset' | 'routines', listener: () => void): () => void;
  on(event: 'command', listener: (event: CommandEvent) => void): () => void;
  on(event: 'diagnostic', listener: (event: Diagnostic) => void): () => void;
  on(event: string, listener: (event: never) => void): () => void {
    this.check();
    const listeners = this.listeners.get(event) ?? new Set();
    const callback = listener as (value: unknown) => void;
    listeners.add(callback);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(callback);
    };
  }
  private emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  async monitor(config: MonitorConfig, options?: RequestOptions): Promise<Recording> {
    this.check();
    if (options?.signal?.aborted) throw failure('aborted');
    if (config.scope.kind === 'command' && this.used.has(config.scope.id))
      throw failure('conflict');
    if (
      !Number.isSafeInteger(config.retain.bytes) ||
      config.retain.bytes < 1 ||
      (config.retain.kind === 'rolling' &&
        config.retain.frames !== undefined &&
        (!Number.isSafeInteger(config.retain.frames) || config.retain.frames < 1))
    )
      throw failure('invalid-input');
    const recording = new ScaleRecording(this, config);
    this.recordings.add(recording);
    if (config.scope.kind === 'live') {
      recording.bind(this.core.store.state);
      if (recording.error) {
        await recording.close();
        throw recording.error;
      }
    }
    return this.core.service.capturesRegistry.add(recording);
  }
  async call(command: Command, options: CallOptions = {}): Promise<CommandResult> {
    this.check();
    const id = options.id ?? crypto.randomUUID();
    if (this.used.has(id)) throw failure('conflict');
    this.used.add(id);
    const captures = [...this.recordings].filter(
      (r) => r.scope.kind === 'command' && r.scope.id === id && r.status === 'armed',
    );
    const routine = routines.find((r) => r.id === command.routine),
      frames = command.values.frames,
      factor = command.values.factor;
    if (
      !routine ||
      typeof frames !== 'number' ||
      !Number.isSafeInteger(frames) ||
      frames < 0 ||
      frames > 1024 ||
      typeof factor !== 'number' ||
      !Number.isFinite(factor) ||
      options.signal?.aborted
    ) {
      const error = failure(options.signal?.aborted ? 'aborted' : 'invalid-input');
      for (const r of captures) r.fail(error);
      throw error;
    }
    if (routine.mode === 'live' && [...this.work.values()].some((work) => work.mode === 'live')) {
      const error = failure('busy');
      for (const r of captures) r.fail(error);
      throw error;
    }
    const state = this.core.store.state;
    for (const r of captures) {
      r.liveCommand = routine.mode === 'live';
      r.bind(state);
    }
    const interested = () =>
      [...this.recordings].filter(
        (r) => captures.includes(r) || (routine.mode === 'live' && r.scope.kind === 'live'),
      );
    const update = (status: CommandEntry['status'], error?: Failure): void => {
      const result = { frames };
      const detail =
        status === 'complete'
          ? ({ status, result } as const)
          : status === 'failed'
            ? ({ status, error: error! } as const)
            : { status };
      for (const r of interested())
        r.observe({
          id,
          routine: routine.id,
          values: { frames, factor },
          documentVersion: state.version,
          firstFrame: 0,
          endFrame: r.frameCount,
          ...detail,
        } as CommandEntry);
      this.emit('command', { id, documentVersion: state.version, ...detail, kind: status });
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    update('queued');
    const promise = (async () => {
      await setImmediate();
      try {
        if (controller.signal.aborted) throw failure('aborted');
        update('running');
        for (let f = 0; f < frames; f++) {
          const coordinate = routine.mode === 'live' ? this.coordinate++ : f;
          const values = new Float64Array(this.core.store.rows);
          for (let page = 0; page * this.core.store.pageRows < values.length; page++) {
            const gate = this.core.service.gate;
            if (gate) {
              this.core.service.stats.waitingCommands++;
              try {
                await interrupt(gate, controller.signal);
              } finally {
                this.core.service.stats.waitingCommands--;
              }
            }
            if (controller.signal.aborted) throw failure('aborted');
            const input = this.core.store.page(state, page),
              offset = page * this.core.store.pageRows;
            for (let i = 0; i < input.length; i++)
              values[offset + i] = input[i] * factor + coordinate;
            await setImmediate();
          }
          if (controller.signal.aborted) throw failure('aborted');
          const frame = { coordinate, values };
          for (const r of interested()) r.append(frame);
        }
        update('complete');
        return { frames };
      } catch (error) {
        const problem = error as Failure;
        update(problem.code === 'aborted' ? 'cancelled' : 'failed', problem);
        throw error;
      } finally {
        for (const r of captures) r.finish('command-finished');
        options.signal?.removeEventListener('abort', abort);
        this.work.delete(id);
      }
    })();
    this.work.set(id, { controller, mode: routine.mode, promise });
    return promise;
  }
  changing(): void {
    for (const r of this.recordings)
      if (r.scope.kind === 'live' || r.liveCommand) r.finish('document-changed');
    for (const work of this.work.values()) if (work.mode === 'live') work.controller.abort();
  }
  async reset(): Promise<void> {
    this.check();
    this.resetting = true;
    try {
      for (const r of this.recordings) r.ending = 'model-reset';
      for (const work of this.work.values()) work.controller.abort();
      await Promise.allSettled([...this.work.values()].map((w) => w.promise));
      for (const r of [...this.recordings]) {
        r.finish('model-reset');
      }
      this.coordinate = 0;
    } finally {
      this.resetting = false;
    }
    this.emit('reset');
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      for (const r of this.recordings) r.ending = 'model-closed';
      for (const work of this.work.values()) work.controller.abort();
      await Promise.allSettled([...this.work.values()].map((w) => w.promise));
      for (const r of [...this.recordings]) r.finish('model-closed');
      this.listeners.clear();
      this.core.models.delete(this);
      this.core.service.stats.models--;
      this.core.service.release(this.core);
    })());
  }
}
class ScaleRecording extends ScaleSource implements Recording {
  readonly id = crypto.randomUUID();
  readonly modelId: string;
  private disposed = false;
  ending?: Extract<RecordingOutcome, { status: 'stopped' }>['reason'];
  readonly scope: MonitorScope;
  readonly documentId: string;
  documentVersion: string | null = null;
  status: RecordingStatus = 'armed';
  fields: readonly RecordedFields[] | null = null;
  axis: Axis | null = null;
  firstFrame = 0;
  frameCount = 0;
  error: Failure | null = null;
  version = '0';
  private bound = deferred();
  private completed = deferred<RecordingOutcome>();
  readonly ready = this.bound.promise;
  readonly done = this.completed.promise;
  private state?: State;
  private frames: Frame[] = [];
  private coverage?: RowAxis;
  private entries: CommandEntry[] = [];
  private firstCoordinate?: number;
  private evictedThrough?: number;
  liveCommand = false;
  constructor(
    readonly model: ScaleModel,
    readonly config: MonitorConfig,
  ) {
    const service = model.core.service;
    super(model.core.store, () => service.gate);
    this.modelId = model.id;
    this.store.retentions++;
    this.scope = config.scope;
    this.documentId = model.documentId;
  }
  get range(): Domain | null {
    return this.frames.length ? [this.frames[0].coordinate, this.frames.at(-1)!.coordinate] : null;
  }
  pin(): Read {
    if (this.disposed) throw failure('closed');
    if (!this.state) throw failure('busy');
    return {
      state: this.state,
      version: this.version,
      schema: {
        ...schema,
        queries: ['rows', 'samples', 'aggregate'],
        axis: this.axis!,
        components: { Node: { fields: schema.components.Node.fields } },
      },
      frames: this.frames.slice(),
      coverage: this.coverage,
      firstFrame: this.firstFrame,
      frameCount: this.frameCount,
      firstCoordinate: this.firstCoordinate,
      evictedThrough: this.evictedThrough,
    };
  }
  bind(state: State): void {
    try {
      if (
        this.config.fields.length !== 1 ||
        this.config.fields[0].from !== 'Node' ||
        this.config.fields[0].select.length !== 1 ||
        this.config.fields[0].select[0] !== 'output'
      )
        throw failure('invalid-input');
      this.coverage = this.store.select(this.config.fields[0].rows);
      this.state = state;
      this.documentVersion = state.version;
      this.axis = { name: 'time', unit: 's' };
      this.fields = [
        { from: 'Node', select: ['output'], rows: this.coverage, index: this.store.index },
      ];
      this.status = 'monitoring';
      this.bound.resolve();
      this.publish({ kind: 'status' });
    } catch (error) {
      this.fail(error as Failure);
    }
  }
  observe(entry: CommandEntry): void {
    if (this.status !== 'monitoring') return;
    const previous = this.entries.findIndex((e) => e.id === entry.id);
    if (previous < 0) this.entries.push(entry);
    else this.entries[previous] = entry;
    this.version = String(Number(this.version) + 1);
    this.publish({ kind: 'commands', version: this.version });
  }
  append(frame: Frame): void {
    if (this.status !== 'monitoring') return;
    const retention = this.config.retain;
    // The fixture retains the full native output allocation even for a sparse capture; charge it honestly.
    const capacity = Math.min(
      Math.floor(retention.bytes / (frame.values.byteLength + 8)),
      retention.kind === 'rolling' ? (retention.frames ?? Infinity) : Infinity,
    );
    if (!capacity || (retention.kind === 'all' && this.frames.length >= capacity)) {
      if (retention.onLimit === 'fail') this.fail(failure('resource-limit'));
      else this.finish('limit');
      return;
    }
    while (this.frames.length >= capacity) {
      const evicted = this.frames.shift()!;
      this.evictedThrough = evicted.coordinate;
      this.model.core.service.drop(evicted);
      this.firstFrame++;
    }
    this.firstCoordinate ??= frame.coordinate;
    this.frames.push(frame);
    this.model.core.service.hold(frame);
    this.frameCount++;
    this.version = String(Number(this.version) + 1);
    if (this.evictedThrough !== undefined)
      this.publish({ kind: 'evict', version: this.version, beforeFrame: this.firstFrame });
    this.publish({
      kind: 'append',
      version: this.version,
      frames: { offset: this.frameCount - 1, count: 1 },
    });
  }
  finish(reason: Extract<RecordingOutcome, { status: 'stopped' }>['reason']): void {
    if (this.status !== 'armed' && this.status !== 'monitoring') return;
    if (!this.state) this.bound.reject(failure('aborted'));
    this.status = 'stopped';
    this.completed.resolve({ status: 'stopped', reason: this.ending ?? reason });
    this.model.recordings.delete(this);
    this.publish({ kind: 'status' });
  }
  fail(error: Failure): void {
    if (!this.state) this.bound.reject(error);
    this.status = 'failed';
    this.error = error;
    this.completed.resolve({ status: 'failed', error });
    this.publish({ kind: 'status' });
  }
  async stop(): Promise<void> {
    this.finish('requested');
  }
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.finish('released');
    await this.cancel();
    for (const frame of this.frames) this.model.core.service.drop(frame);
    this.frames = [];
    this.state = undefined;
    this.store.retentions--;
    this.store.onRelease();
    this.model.recordings.delete(this);
    this.publish({ kind: 'closed' });
    this.listeners.clear();
  }
  async commands(page: { offset?: number; limit: number }, options?: RequestOptions) {
    if (this.disposed) throw failure('closed');
    if (options?.signal?.aborted) throw failure('aborted');
    return {
      version: this.version,
      items: this.entries.slice(page.offset ?? 0, (page.offset ?? 0) + page.limit),
      total: this.entries.length,
    };
  }
  async diagnostics(_page: { after?: number; limit: number }, options?: RequestOptions) {
    if (this.disposed) throw failure('closed');
    if (options?.signal?.aborted) throw failure('aborted');
    return {
      version: this.version,
      items: [] as Diagnostic[],
      firstSequence: null,
      discardedThrough: null,
    };
  }
  async export(options?: RequestOptions): Promise<Export> {
    return exported(this.store, this.pin(), this.entries, options);
  }
}
function exported(
  store: Store,
  read: Read,
  commands: readonly CommandEntry[],
  options?: RequestOptions,
): Export {
  // Test-only framed export: JSON manifest length, manifest, input pages, frame arrays. Not a portable archive.
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      version: read.version,
      schema: read.schema,
      rows: store.rows,
      commands,
      coordinates: read.frames?.map((f) => f.coordinate) ?? [],
    }),
  );
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, manifest.length, true);
  function* chunks() {
    yield length;
    yield manifest;
    for (let p = 0; p * store.pageRows < store.rows; p++) {
      const page = store.page(read.state, p);
      yield new Uint8Array(page.buffer, page.byteOffset, page.byteLength);
    }
    for (const frame of read.frames ?? [])
      for (let start = 0; start < frame.values.length; start += store.pageRows) {
        const page = frame.values.subarray(start, start + store.pageRows);
        yield new Uint8Array(page.buffer, page.byteOffset, page.byteLength);
      }
  }
  const iterator = chunks();
  return {
    version: read.version,
    mediaType: 'application/vnd.latkit.scale-test',
    stream: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (options?.signal?.aborted) {
            controller.error(failure('aborted'));
            iterator.return();
            return;
          }
          const next = iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          iterator.return();
        },
      },
      { highWaterMark: 0 },
    ),
  };
}
