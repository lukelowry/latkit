/** Scale fixture only: native paged inputs and real asynchronous computation, not a production solver. */
import { setImmediate } from 'node:timers/promises';
import type {
  Command,
  CommandResult,
  Diagnostic,
  Domain,
  Export,
  Failure,
  FieldSelection,
  Model,
  RecordingStatus,
  Recording,
  RequestOptions,
  RowAxis,
  Routine,
  Schema,
} from '../../src/index.js';
import { RetainedBudget } from '../retention.js';
import { ScaleSource, schema } from './source.js';
import type { Frame, Read } from './source.js';
import { Store, failure, interrupt, metrics } from './store.js';
import type { Metrics } from './store.js';
const routines: readonly Routine[] = [
  {
    id: 'simulate',
    label: 'Simulate',
    records: true,
    parameters: [
      {
        id: 'frames',
        label: 'Frames',
        type: 'number',
        integer: true,
        bounds: { lower: { value: 0 }, upper: { value: 1024 } },
      },
      { id: 'factor', label: 'Factor', type: 'number' },
    ],
  },
];
export class ScaleModel extends ScaleSource implements Model {
  readonly name = 'Scale';
  readonly version = '1';
  readonly routines = routines;
  readonly monitors = new Set<ScaleRecording>();
  /** Settles once the latest command has: commands take turns in the order given. */
  private last: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly commands = new Set<AbortController>();
  constructor(rows = 1_000_000, pageRows = 8192, retention = new RetainedBudget()) {
    super(new Store(crypto.randomUUID(), rows, pageRows, metrics(), retention));
  }
  get stats(): Metrics {
    return this.store.stats;
  }
  get retention(): RetainedBudget {
    return this.store.retention;
  }
  inspect(): Metrics {
    return { ...this.stats };
  }
  /** Test control: hold every read and command at its next step until resumed. */
  pause(paused: boolean): void {
    this.store.pause(paused);
  }
  pin(): Read {
    if (this.closed) throw failure('closed');
    return { version: this.version, schema };
  }
  private check(options?: RequestOptions): void {
    if (this.closed) throw failure('closed');
    if (options?.signal?.aborted) throw failure('aborted');
  }
  async monitor(fields: readonly FieldSelection[], options?: RequestOptions): Promise<Recording> {
    this.check(options);
    const [selection] = fields;
    if (
      fields.length !== 1 ||
      selection.from !== 'Node' ||
      selection.select.length !== 1 ||
      selection.select[0] !== 'output'
    )
      throw failure('invalid-input');
    const monitor = new ScaleRecording(this, this.store.select(selection.rows));
    this.monitors.add(monitor);
    return monitor;
  }
  async run(command: Command, options: RequestOptions = {}): Promise<CommandResult> {
    this.check(options);
    const { frames, factor } = command.values;
    if (
      command.routine !== 'simulate' ||
      typeof frames !== 'number' ||
      !Number.isSafeInteger(frames) ||
      frames < 0 ||
      frames > 1024 ||
      typeof factor !== 'number' ||
      !Number.isFinite(factor)
    )
      throw failure('invalid-input');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    this.commands.add(controller);
    // Its turn ends only once the one before it has, even when it leaves the queue early.
    const before = this.last;
    let ended!: () => void;
    this.last = new Promise((resolve) => (ended = resolve));
    try {
      await interrupt(before, controller.signal);
      return await this.compute(frames, factor, controller.signal);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.commands.delete(controller);
      void before.then(ended);
    }
  }
  private async compute(
    frames: number,
    factor: number,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const monitors = [...this.monitors];
    for (const monitor of monitors) monitor.start(frames);
    try {
      for (let f = 0; f < frames; f++) {
        const values = new Float64Array(this.store.rows);
        for (let page = 0; page * this.store.pageRows < values.length; page++) {
          const gate = this.store.gate;
          if (gate) {
            this.stats.waitingCommands++;
            try {
              await interrupt(gate, signal);
            } finally {
              this.stats.waitingCommands--;
            }
          }
          if (signal.aborted) throw failure('aborted');
          const input = this.store.page(page),
            offset = page * this.store.pageRows;
          for (let i = 0; i < input.length; i++) values[offset + i] = input[i] * factor + f;
          await setImmediate();
        }
        if (signal.aborted) throw failure('aborted');
        const frame = { coordinate: f, values };
        for (const monitor of monitors) monitor.append(frame);
      }
      for (const monitor of monitors) monitor.end('complete');
      return { frames };
    } catch (error) {
      const problem = error as Failure;
      for (const monitor of monitors)
        monitor.end(problem.code === 'aborted' ? 'cancelled' : 'failed', problem);
      throw error;
    }
  }
  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.commands) controller.abort();
    await this.last;
    await super.close();
  }
}
class ScaleRecording extends ScaleSource implements Recording {
  status: RecordingStatus = 'idle';
  progress: number | null = null;
  diagnostics: readonly Diagnostic[] = [];
  version = '0';
  private recorded: Frame[] = [];
  private total = 0;
  /** Releases for the frames it holds, counted once per frame by the store. */
  private holds: (() => void)[] = [];
  private disposed = false;
  private readonly schema: Schema = {
    ...schema,
    queries: ['rows', 'samples', 'aggregate'],
    axis: { name: 'time', unit: 's' },
  };
  constructor(
    readonly model: ScaleModel,
    readonly coverage: RowAxis,
  ) {
    super(model.store);
  }
  get frames(): number {
    return this.recorded.length;
  }
  get range(): Domain | null {
    const last = this.recorded.at(-1);
    return last ? [this.recorded[0].coordinate, last.coordinate] : null;
  }
  pin(): Read {
    if (this.disposed) throw failure('closed');
    return {
      version: this.version,
      schema: this.schema,
      frames: this.recorded.slice(),
      coverage: this.coverage,
      firstFrame: 0,
      frameCount: this.recorded.length,
      firstCoordinate: this.recorded[0]?.coordinate,
    };
  }
  /** A command of `total` frames starts it over. */
  start(total: number): void {
    if (this.disposed) return;
    this.drop();
    this.recorded = [];
    this.total = total;
    this.progress = total ? 0 : 1;
    this.diagnostics = [];
    this.status = 'running';
    this.version = String(Number(this.version) + 1);
    this.publish({ kind: 'replace', version: this.version });
    this.publish({ kind: 'status' });
  }
  /** The fixture keeps each frame's whole native output, even for a sparse monitor. */
  append(frame: Frame): void {
    if (this.disposed) return;
    this.recorded.push(frame);
    this.holds.push(this.store.hold([frame]));
    this.progress = this.recorded.length / this.total;
    this.version = String(Number(this.version) + 1);
    this.publish({
      kind: 'append',
      version: this.version,
      frames: { offset: this.recorded.length - 1, count: 1 },
    });
    this.publish({ kind: 'status' });
  }
  end(status: 'complete' | 'cancelled' | 'failed', error?: Failure): void {
    if (this.disposed) return;
    this.status = status;
    if (status === 'failed' && error)
      this.diagnostics = [
        ...this.diagnostics,
        { code: error.code, message: error.message, severity: 'error' },
      ];
    this.publish({ kind: 'status' });
  }
  async export(options?: RequestOptions): Promise<Export> {
    return exported(this.store, this.pin(), options);
  }
  override async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.model.monitors.delete(this);
    this.drop();
    this.recorded = [];
    await super.close();
  }
  private drop(): void {
    for (const release of this.holds.splice(0)) release();
  }
}
function exported(store: Store, read: Read, options?: RequestOptions): Export {
  // Test-only framed export: JSON manifest length, manifest, input pages, frame arrays. Not a portable archive.
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      version: read.version,
      schema: read.schema,
      rows: store.rows,
      coordinates: read.frames?.map((f) => f.coordinate) ?? [],
    }),
  );
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, manifest.length, true);
  function* chunks() {
    yield length;
    yield manifest;
    for (let p = 0; p * store.pageRows < store.rows; p++) {
      const page = store.page(p);
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
