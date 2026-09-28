/**
 * A model served across a port: its description and each class packed as they are asked for, and
 * the recordings its engine makes, forwarded call by call as the engine writes them.
 * `connectModel` opens it on the far side, classes still lazy, recording with the served engine;
 * only packs and recorder calls cross.
 */

import { Engine, Model, type Domain } from '@latkit/model';

import { connect, serve, transferred, type Connection, type Remote } from './channel.js';
import { check, type Check } from './check.js';
import type { Port } from './port.js';
import { protocol, type Progress } from './protocol.js';

type Request =
  | { readonly op: 'open' }
  | { readonly op: 'class'; readonly id: string }
  | { readonly op: 'bytes' };

/** What an open replies: the core, and whether the model records. */
interface Opened {
  readonly core: Uint8Array;
  readonly recordable: boolean;
}

/** One call the served engine made on its recorder, as it crosses. */
type Call =
  | {
      readonly call: 'declare';
      readonly extent: { readonly span?: Domain | null; readonly expectedFrames?: number | null };
    }
  | { readonly call: 'wait'; readonly ahead: number }
  | { readonly call: 'start' }
  | {
      readonly call: 'append';
      readonly time: Float64Array;
      readonly values: Readonly<Record<string, Float32Array | Float64Array>>;
    }
  | { readonly call: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string };

const MODEL = protocol<Request, Uint8Array | Opened>(
  'model',
  check.requests<Request>({ open: {}, class: { id: check.string }, bytes: {} }),
);

/** A recording's input goes to the served engine, whose own parse is the check. */
const RECORD = protocol<unknown, Call>('model:record');

/** Calls a forwarding recorder holds before it says it is not ready for more. */
const BACKLOG = 16;

const opened: Check<Opened> = check.object<Opened>({
  core: check.bytes,
  recordable: check.boolean,
});

/**
 * Serve one model on `port` until either side closes. Returns the server's own close.
 *
 * @remarks
 * A model still opening is served once it opens, so no early request is lost. A recording the peer
 * asks for is made by the engine attached to the model when it asks, which checks the input,
 * queues what it cannot take at once, and stops when the peer stops the recording.
 *
 * @param options - `onClose` fires once the service has ended.
 */
export function serveModel(
  port: Port,
  model: Model | Promise<Model>,
  options: { onClose?(): void } = {},
): () => void {
  let served: Promise<Model> | null = Promise.resolve(model);
  // A rejected open is reported by the first request that awaits it.
  void served.catch(() => undefined);
  const current = (): Promise<Model> =>
    served ?? Promise.reject(new Error('the served model was closed'));

  function close(): void {
    if (!served) return;
    served = null;
    options.onClose?.();
  }

  const calls = serve(
    port,
    MODEL,
    async (request, signal, progress) => {
      const model = await current();
      const source = model.source();
      const owned = (data: Uint8Array) => transferred(data, [data.buffer as ArrayBuffer]);
      switch (request.op) {
        case 'open': {
          const core = await source.core(signal, progress);
          return transferred<Opened>({ core, recordable: model.engine !== null }, [
            core.buffer as ArrayBuffer,
          ]);
        }
        case 'class':
          return owned(await source.class(request.id, signal));
        case 'bytes':
          return owned(await source.bytes(signal));
      }
    },
    { onClose: close },
  );

  const records = serve(port, RECORD, async function* (input, signal) {
    const model = await current();
    const engine = model.engine;
    if (!engine) throw new Error('the served model has no engine');
    yield* forward(engine, model, input, signal);
  });

  return () => {
    calls.close();
    records.close();
  };
}

/**
 * Record `model` for `input` on `engine`, yielding each recorder call as the engine makes it; an
 * append's buffers cross without a copy, since a recorder takes them.
 */
async function* forward(engine: Engine, model: Model, input: unknown, signal: AbortSignal) {
  const queue: Call[] = [];
  let taken = 0;
  let wake = null as (() => void) | null;
  let settled = null as { readonly error: Error | null } | null;
  let ready = Promise.resolve();
  let release = null as (() => void) | null;
  const push = (call: Call): void => {
    queue.push(call);
    if (!release && queue.length - taken >= BACKLOG)
      ready = new Promise<void>((resolve) => (release = resolve));
    const pending = wake;
    wake = null;
    pending?.();
  };
  const recorder: Engine.Recorder = {
    signal,
    get ready() {
      return ready;
    },
    declare: (extent) =>
      push({
        call: 'declare',
        extent: {
          ...(extent.span !== undefined && { span: extent.span }),
          ...(extent.expectedFrames !== undefined && { expectedFrames: extent.expectedFrames }),
        },
      }),
    wait: (ahead) => push({ call: 'wait', ahead }),
    start: () => push({ call: 'start' }),
    append: (time, values) => push({ call: 'append', time, values }),
    log: (level, message) => push({ call: 'log', level, message }),
  };
  void engine
    .record(model, input, recorder)
    .then(
      () => (settled = { error: null }),
      (error: unknown) =>
        (settled = { error: error instanceof Error ? error : new Error('the engine failed') }),
    )
    .finally(() => {
      const pending = wake;
      wake = null;
      pending?.();
    });
  for (;;) {
    while (taken < queue.length) {
      const call = queue[taken]!;
      queue[taken++] = undefined as never;
      if (release && queue.length - taken < BACKLOG / 2) {
        release();
        release = null;
      }
      yield call.call === 'append' ? transferred(call, buffersOf(call)) : call;
    }
    queue.length = taken = 0;
    if (settled) {
      if (settled.error !== null) throw settled.error;
      return;
    }
    await new Promise<void>((resolve) => (wake = resolve));
  }
}

/** Each buffer an append carries, once. */
function buffersOf(call: Extract<Call, { call: 'append' }>): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>([call.time.buffer as ArrayBuffer]);
  for (const values of Object.values(call.values)) buffers.add(values.buffer as ArrayBuffer);
  return [...buffers];
}

/** The engine of a model served elsewhere: every recording crosses to the served engine. */
class Served extends Engine {
  readonly #records: Connection<unknown, Call>;

  constructor(records: Connection<unknown, Call>) {
    // The served engine queues for itself, and says where a recording stands in its queue.
    super({ concurrency: Infinity });
    this.#records = records;
  }

  protected parse(input: unknown): unknown {
    return input;
  }

  protected async execute(_model: Model, input: unknown, recorder: Engine.Recorder): Promise<void> {
    for await (const item of this.#records.stream(input, { signal: recorder.signal })) {
      const call = item as Partial<Call> | null;
      switch (call?.call) {
        case 'declare':
          recorder.declare(call.extent ?? {});
          break;
        case 'wait':
          recorder.wait(call.ahead!);
          break;
        case 'start':
          recorder.start();
          break;
        case 'append':
          recorder.append(call.time!, call.values!);
          break;
        case 'log':
          recorder.log(call.level!, call.message!);
          break;
        default:
          throw new TypeError('a served engine sent a call no recorder takes');
      }
    }
    recorder.signal.throwIfAborted();
  }
}

/**
 * Open the model a `serveModel` peer serves: its classes load across the port as they are asked
 * for, and it records with the peer's engine when the peer has one. Closing it closes the
 * connection.
 *
 * @throws Error when the peer cannot open the model, or serves an inconsistent one.
 */
export async function connectModel(
  port: Port,
  options: { readonly signal?: AbortSignal; readonly progress?: Progress } = {},
): Promise<Remote<Model>> {
  const calls = connect(port, MODEL);
  const records = connect(port, RECORD);
  const close = (): void => {
    calls.close();
    records.close();
  };
  const ask = async (request: Request, signal?: AbortSignal): Promise<Uint8Array> => {
    const reply = await calls.call(request, { signal });
    check.bytes(reply, `model ${request.op} reply`);
    return reply;
  };
  try {
    const reply = await calls.call(
      { op: 'open' },
      { signal: options.signal, progress: options.progress },
    );
    opened(reply, 'model open reply');
    const { core, recordable } = reply;
    const model = await Model.from({
      core: () => Promise.resolve(core),
      class: (id, signal) => ask({ op: 'class', id }, signal),
      bytes: (signal) => ask({ op: 'bytes' }, signal),
    });
    if (recordable) model.engine = new Served(records);
    return Object.assign(model, { close });
  } catch (error) {
    close();
    throw error;
  }
}
