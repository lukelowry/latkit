/** Test implementations, deliberately not exported by the package. */
import type {
  Command,
  CommandResult,
  Diagnostic,
  Domain,
  Export,
  Failure,
  FieldSelection,
  Model,
  QueryBlock,
  QueryHeader,
  Recording,
  RecordingStatus,
  RequestOptions,
  Routine,
  RowAxis,
  Schema,
} from '../src/index.js';
import { RetainedBudget } from './retention.js';
import { Source, failure, selectRows } from './source.js';
import type { Frame, Inputs, ReadState } from './source.js';
export { failure } from './source.js';
export const fixtureSchema: Schema = {
  queries: ['rows', 'aggregate'],
  limits: { maxBlockBytes: 4096 },
  components: {
    Node: {
      fields: {
        value: { type: 'float64' },
        output: { type: 'float64', sampled: true },
        other: { type: 'float64', sampled: true },
      },
    },
  },
  connections: {},
};
export async function collect<B extends QueryBlock>(
  source: AsyncIterable<QueryHeader | B>,
): Promise<B[]> {
  const values: B[] = [];
  for await (const value of source) if (value.kind !== 'schema') values.push(value as B);
  return values;
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

/** Each field a monitor streams, and the rows it streams them for. */
function coverageOf(fields: readonly FieldSelection[], inputs: Inputs): Map<string, RowAxis> {
  if (!fields.length) throw failure('invalid-input', 'A monitor streams at least one field.');
  const coverage = new Map<string, RowAxis>();
  for (const selection of fields) {
    if (selection.from !== 'Node' || !selection.select.length) throw failure('invalid-input');
    const rows = selectRows(inputs, selection.rows);
    for (const field of selection.select) {
      if (!fixtureSchema.components.Node.fields[field]?.sampled || coverage.has(field))
        throw failure('invalid-input');
      coverage.set(field, rows);
    }
  }
  return coverage;
}

/** A command waiting its turn or running. Tests drive the running one with frame() and finish(). */
interface Work {
  readonly routine: Routine;
  readonly resolve: (result: CommandResult) => void;
  readonly reject: (error: Failure) => void;
  cleanup: () => void;
  inputs?: Inputs;
  monitors: readonly FixtureRecording[];
  frames: number;
}
let nextModel = 0;
export class FixtureModel extends Source implements Model {
  readonly id = 'fixture-' + nextModel++;
  readonly name = 'Fixture';
  readonly routines: readonly Routine[] = [
    { id: 'solve', label: 'Solve', parameters: [], records: true },
    { id: 'check', label: 'Check', parameters: [] },
  ];
  inputs: Inputs;
  readonly monitors = new Set<FixtureRecording>();
  /** Commands in the order given; the first one is running. */
  readonly queue: Work[] = [];
  private counter = 1;
  private nextId = 5;
  private closed = false;
  constructor(retention = new RetainedBudget()) {
    super(retention);
    this.inputs = {
      version: '1',
      index: { source: this.id, type: 'Node', version: '1' },
      ids: ['n1', 'n2', 'n3', 'n4'],
      values: new Float64Array([1, 2, 3, 4]),
    };
  }
  get version(): string {
    return this.inputs.version;
  }
  stateForRead(): ReadState {
    if (this.closed) throw failure('closed');
    return { inputs: this.inputs, version: this.version, schema: fixtureSchema };
  }
  private check(options?: RequestOptions): void {
    if (this.closed) throw failure('closed');
    if (options?.signal?.aborted) throw failure('aborted');
  }
  /** Test control: its application replaced the file, so the data and its identities are new. */
  replace(values: Float64Array = new Float64Array([1, 2, 3, 4])): void {
    this.check();
    const version = String(++this.counter);
    this.inputs = {
      version,
      index: { source: this.id, type: 'Node', version },
      ids: Array.from(values, () => 'n' + this.nextId++),
      values,
    };
    this.publish({ kind: 'replace', version });
  }
  async monitor(
    fields: readonly FieldSelection[],
    options?: RequestOptions,
  ): Promise<FixtureRecording> {
    this.check(options);
    const recording = new FixtureRecording(this, coverageOf(fields, this.inputs));
    this.monitors.add(recording);
    return recording;
  }
  run(command: Command, options: RequestOptions = {}): Promise<CommandResult> {
    try {
      this.check(options);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const routine = this.routines.find((entry) => entry.id === command.routine);
    if (!routine)
      return Promise.reject(
        Object.assign(failure('invalid-input', 'Unknown routine.'), {
          issues: [
            {
              code: 'invalid-input',
              message: 'Unknown routine.',
              target: { kind: 'path', path: ['routine'] },
            },
          ],
        }),
      );
    return new Promise<CommandResult>((resolve, reject) => {
      const work: Work = { routine, resolve, reject, cleanup: () => {}, monitors: [], frames: 0 };
      const abort = (): void => this.settle(work, 'cancelled', failure('aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      work.cleanup = () => options.signal?.removeEventListener('abort', abort);
      this.queue.push(work);
      if (this.queue.length === 1) this.start(work);
    });
  }
  /** Test control: the running command computes one frame at `coordinate`. */
  frame(coordinate: number): void {
    const work = this.running();
    const output = work.inputs!.values.map((value) => value + coordinate);
    const frame = { coordinate, values: { output, other: output.map((value) => value * 10) } };
    work.frames++;
    for (const monitor of work.monitors) monitor.append(frame);
  }
  /** Test control: the running command ends, failing with `error` when given. */
  finish(error?: Failure): void {
    this.settle(this.running(), error ? 'failed' : 'complete', error);
  }
  private running(): Work {
    const work = this.queue[0];
    if (!work) throw new Error('No fixture command is running.');
    return work;
  }
  /** It runs on the data current as it starts, and every monitor open then streams it. */
  private start(work: Work): void {
    work.inputs = this.inputs;
    work.monitors = work.routine.records ? [...this.monitors] : [];
    for (const monitor of work.monitors) monitor.start(this.inputs);
  }
  private settle(work: Work, status: 'complete' | 'cancelled' | 'failed', error?: Failure): void {
    const position = this.queue.indexOf(work);
    if (position < 0) return;
    this.queue.splice(position, 1);
    work.cleanup();
    for (const monitor of work.monitors) monitor.end(status, error);
    if (error) work.reject(error);
    else work.resolve({ frames: work.frames });
    if (position === 0 && this.queue.length) this.start(this.queue[0]);
  }
  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Queued commands first, so cancelling the running one starts nothing.
    for (const work of [...this.queue].reverse())
      this.settle(work, 'cancelled', failure('aborted'));
    await super.close();
  }
}

export class FixtureRecording extends Source implements Recording {
  status: RecordingStatus = 'idle';
  progress: number | null = null;
  diagnostics: readonly Diagnostic[] = [];
  version = '0';
  private inputs: Inputs;
  private recorded: Frame[] = [];
  private firstCoordinate?: number;
  private disposed = false;
  private readonly schema: Schema;
  constructor(
    readonly model: FixtureModel,
    readonly coverage: ReadonlyMap<string, RowAxis>,
  ) {
    super(model.retention);
    this.inputs = model.inputs;
    const { fields } = fixtureSchema.components.Node;
    this.schema = {
      ...fixtureSchema,
      queries: ['rows', 'samples', 'aggregate'],
      axis: { name: 'time', unit: 's' },
      components: {
        Node: {
          fields: Object.fromEntries(
            Object.entries(fields).filter(
              ([name, definition]) => !definition.sampled || coverage.has(name),
            ),
          ),
        },
      },
    };
  }
  get frames(): number {
    return this.recorded.length;
  }
  get range(): Domain | null {
    const last = this.recorded.at(-1);
    return last ? [this.recorded[0].coordinate, last.coordinate] : null;
  }
  stateForRead(): ReadState {
    if (this.disposed) throw failure('closed');
    return {
      inputs: this.inputs,
      version: this.version,
      schema: this.schema,
      frames: this.recorded.slice(),
      firstFrame: 0,
      frameCount: this.recorded.length,
      firstCoordinate: this.firstCoordinate,
      coverage: this.coverage,
    };
  }
  /** A command starts it over, on the data that command runs on. */
  start(inputs: Inputs): void {
    if (this.disposed) return;
    this.inputs = inputs;
    this.recorded = [];
    this.firstCoordinate = undefined;
    this.diagnostics = [];
    this.status = 'running';
    this.version = String(Number(this.version) + 1);
    this.publish({ kind: 'replace', version: this.version });
    this.publish({ kind: 'status' });
  }
  append(frame: Frame): void {
    if (this.disposed || this.status !== 'running') return;
    const last = this.recorded.at(-1);
    if (last && frame.coordinate < last.coordinate) throw new Error('Fixture frames go forward.');
    this.firstCoordinate ??= frame.coordinate;
    this.recorded.push({
      coordinate: frame.coordinate,
      values: Object.fromEntries(
        [...this.coverage.keys()].map((field) => [field, frame.values[field]]),
      ),
    });
    this.version = String(Number(this.version) + 1);
    this.publish({
      kind: 'append',
      version: this.version,
      frames: { offset: this.recorded.length - 1, count: 1 },
    });
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
  async export(): Promise<Export> {
    const { inputs, frames } = this.stateForRead();
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        inputs: [...inputs.values],
        frames: frames!.map((frame) => [
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
      stream: byteStream(bytes),
    };
  }
  override async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.model.monitors.delete(this);
    this.recorded = [];
    await super.close();
  }
}
