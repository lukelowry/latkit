/**
 * An engine served across a port: a peer records any model with it, and the recording fills on
 * the peer's side as the engine writes it, call by call, its frames handed over without a copy. A
 * model the engine's realm serves crosses by reference and is recorded where it lives; any other
 * is lent by its source, which the engine reads only as it needs.
 */

import { Engine, Model, type Domain } from '@latkit/model';

import { connect, serve, transferred, type Connection, type Remote } from './channel.js';
import { check, type Check } from './check.js';
import { homeOf, hosted } from './model.js';
import type { Port } from './port.js';
import { protocol } from './protocol.js';

/**
 * A recording a peer asks for: the engine's input, the key of the model it lends, and, for a
 * model a realm serves, the token that realm knows it by.
 */
interface Request {
  readonly input: unknown;
  readonly lent: number;
  readonly home?: string;
}

/** One call the engine made on its recorder, as it crosses. */
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

/** One read of a lent model's source. */
type Borrow =
  | { readonly op: 'core'; readonly key: number }
  | { readonly op: 'class'; readonly key: number; readonly id: string }
  | { readonly op: 'bytes'; readonly key: number };

/** An input is the served engine's to check: its own `parse` is the check. */
const input: Check<unknown> = () => undefined;

const RECORD = protocol<Request, Call>(
  'engine:record',
  check.object<Request>({ input, lent: check.index, home: check.optional(check.string) }),
);

const BORROW = protocol<Borrow, Uint8Array>(
  'engine:borrow',
  check.requests<Borrow>({
    core: { key: check.index },
    class: { key: check.index, id: check.string },
    bytes: { key: check.index },
  }),
);

/** Calls a forwarding recorder holds before it says it is not ready for more. */
const BACKLOG = 16;

/**
 * Serve `engine` on `port` until either side closes: a peer records any model with it. Returns
 * the server's own close.
 *
 * @remarks
 * An engine still opening is served once it opens. A model this realm serves with `serveModel` is
 * recorded in place; any other is opened from the source its peer lends, its classes read only as
 * the engine asks for them. The engine checks every input, queues what it cannot take at once, and
 * stops a recording when its peer stops it.
 *
 * @param options - `onClose` fires once the service has ended.
 */
export function serveEngine(
  port: Port,
  engine: Engine | Promise<Engine>,
  options: { onClose?(): void } = {},
): () => void {
  let served: Promise<Engine> | null = Promise.resolve(engine);
  // A rejected open is reported by the first recording that awaits it.
  void served.catch(() => undefined);
  const current = (): Promise<Engine> =>
    served ?? Promise.reject(new Error('the served engine was closed'));
  const lent = connect(port, BORROW);

  function close(): void {
    if (!served) return;
    served = null;
    lent.close();
    options.onClose?.();
  }

  const records = serve(
    port,
    RECORD,
    async function* (request, signal) {
      const engine = await current();
      const home = request.home === undefined ? undefined : hosted.get(request.home);
      const model = home ? await home : await Model.from(borrowed(lent, request.lent), { signal });
      yield* forward(engine, model, request.input, signal);
    },
    { onClose: close },
  );

  return () => records.close();
}

/** The source a peer lends as `key`, read across the port. */
function borrowed(lent: Connection<Borrow, Uint8Array>, key: number): Model.Source {
  const ask = async (request: Borrow, signal?: AbortSignal): Promise<Uint8Array> => {
    const reply = await lent.call(request, { signal });
    check.bytes(reply, `engine ${request.op} reply`);
    return reply;
  };
  return {
    core: (signal) => ask({ op: 'core', key }, signal),
    class: (id, signal) => ask({ op: 'class', key, id }, signal),
    bytes: (signal) => ask({ op: 'bytes', key }, signal),
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

/** An engine served elsewhere: every recording crosses to it, lending the model it records. */
class Connected extends Engine {
  readonly #records: Connection<Request, Call>;
  readonly #loans: Map<number, Model.Source>;
  #lent = 0;

  constructor(records: Connection<Request, Call>, loans: Map<number, Model.Source>) {
    // The served engine queues for itself, and says where a recording stands in its queue.
    super({ concurrency: Infinity });
    this.#records = records;
    this.#loans = loans;
  }

  protected parse(input: unknown): unknown {
    return input;
  }

  protected async execute(model: Model, input: unknown, recorder: Engine.Recorder): Promise<void> {
    const lent = ++this.#lent;
    this.#loans.set(lent, model.source());
    const home = homeOf(model);
    const request: Request = home === undefined ? { input, lent } : { input, lent, home };
    try {
      for await (const item of this.#records.stream(request, { signal: recorder.signal })) {
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
    } finally {
      this.#loans.delete(lent);
    }
  }
}

/**
 * The engine a `serveEngine` peer serves: it records any model it is given, a model the peer
 * serves where it lives and any other through the source this side lends while it records.
 * Closing it closes the connection.
 */
export function connectEngine(port: Port): Remote<Engine> {
  const records = connect(port, RECORD);
  const loans = new Map<number, Model.Source>();
  const lending = serve(port, BORROW, async (request, signal) => {
    const source = loans.get(request.key);
    if (!source) throw new Error('the model is no longer lent');
    const data =
      request.op === 'class'
        ? await source.class(request.id, signal)
        : request.op === 'core'
          ? await source.core(signal)
          : await source.bytes(signal);
    return transferred(data, [data.buffer as ArrayBuffer]);
  });
  return Object.assign(new Connected(records, loans), {
    close() {
      records.close();
      lending.close();
    },
  });
}
