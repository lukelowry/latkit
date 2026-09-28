/**
 * An engine served across a port: a peer records any model with it, and the recording fills on
 * the peer's side as the engine writes it, call by call, its frames handed over without a copy. A
 * model the engine's realm serves crosses by reference and is recorded where it lives; any other
 * is lent by its source, which the engine reads only as it needs. The studies it offers cross with
 * it, and follow it.
 */

import { Engine, Model, type Domain } from '@latkit/model';

import { connect, serve, transferred, type Connection, type Remote } from './channel.js';
import { check, type Check } from './check.js';
import { homeOf, hosted } from './model.js';
import type { Port } from './port.js';
import { protocol } from './protocol.js';

/**
 * A model a peer lends: the key of the source it lends, and, for a model a realm serves, the token
 * that realm knows it by.
 */
interface Loan {
  readonly lent: number;
  readonly home?: string;
}

/** A recording a peer asks for: the engine's input, and the model it lends. */
interface Request extends Loan {
  readonly input: unknown;
}

/** What a peer asks besides a recording: the studies offered, or the input a saved file holds. */
type Ask =
  { readonly op: 'studies' } | ({ readonly op: 'read'; readonly file: Engine.File } & Loan);

/**
 * The studies an engine offers as of `revision`, which grows with each change, and whether it
 * reads saved files.
 */
interface Offer {
  readonly revision: number;
  readonly studies: readonly Engine.Study[];
  readonly reads: boolean;
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

const loan = { lent: check.index, home: check.optional(check.string) };

const RECORD = protocol<Request, Call>('engine:record', check.object<Request>({ input, ...loan }));

const STUDIES = protocol<Ask, Offer | Engine.Input, Offer>(
  'engine:studies',
  check.requests<Ask>({
    studies: {},
    read: { file: check.object<Engine.File>({ name: check.string, bytes: check.bytes }), ...loan },
  }),
);

const BORROW = protocol<Borrow, Uint8Array>(
  'engine:borrow',
  check.requests<Borrow>({
    core: { key: check.index },
    class: { key: check.index, id: check.string },
    bytes: { key: check.index },
  }),
);

/** Studies one offer carries at most. */
const MAX_STUDIES = 4096;

/** A study as it crosses; the connected engine's `offer` checks its form. */
const study: Check<Engine.Study> = (value, name) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be a study`);
};

const offered: Check<Offer> = check.object<Offer>({
  revision: check.index,
  studies: check.array(study, MAX_STUDIES),
  reads: check.boolean,
});

const values: Check<Engine.Values> = (value, name) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be a map of values`);
};

const saved: Check<Engine.Input> = check.object<Engine.Input>({ study: check.string, values });

/** Calls a forwarding recorder holds before it says it is not ready for more. */
const BACKLOG = 16;

/**
 * Serve `engine` on `port` until either side closes: a peer records any model with it, and learns
 * the studies it offers, following each change. Returns the server's own close.
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
  // A rejected open is reported by the first request that awaits it.
  void served.catch(() => undefined);
  const current = (): Promise<Engine> =>
    served ?? Promise.reject(new Error('the served engine was closed'));
  const lent = connect(port, BORROW);
  let revision = 0;
  let off = (): void => undefined;

  function close(): void {
    if (!served) return;
    served = null;
    off();
    records.close();
    asks.close();
    lent.close();
    options.onClose?.();
  }

  /** The model a peer lends: where this realm serves it, or opened from the source it lends. */
  async function modelOf({ lent: key, home }: Loan, signal: AbortSignal): Promise<Model> {
    const hosting = home === undefined ? undefined : hosted.get(home);
    return hosting ? await hosting : await Model.from(borrowed(lent, key), { signal });
  }

  const offer = (engine: Engine): Offer => ({
    revision,
    studies: engine.studies,
    reads: typeof engine.read === 'function',
  });

  const records = serve(
    port,
    RECORD,
    async function* (request, signal) {
      const engine = await current();
      yield* forward(engine, await modelOf(request, signal), request.input, signal);
    },
    { onClose: close },
  );

  const asks = serve(
    port,
    STUDIES,
    async (request, signal) => {
      const engine = await current();
      if (request.op === 'studies') return offer(engine);
      if (!engine.read) throw new Error('the served engine reads no files');
      return engine.read(await modelOf(request, signal), request.file, signal);
    },
    { onClose: close },
  );

  void served.then(
    (engine) => {
      if (!served) return;
      off = engine.on('change', () => {
        revision++;
        asks.emit(offer(engine));
      });
    },
    () => undefined,
  );

  return close;
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

/**
 * An engine served elsewhere: it offers what its peer offers, and every recording crosses to it,
 * lending the model it records.
 */
class Connected extends Engine {
  readonly #records: Connection<Request, Call>;
  readonly #asks: Connection<Ask, Offer | Engine.Input, Offer>;
  readonly #loans: Map<number, Model.Source>;
  /** Each study the peer offers, as it crossed, and what withdraws this engine's offer of it. */
  readonly #mirrored = new Map<string, { readonly as: string; readonly withdraw: () => void }>();
  #revision = -1;
  #lent = 0;

  constructor(
    records: Connection<Request, Call>,
    asks: Connection<Ask, Offer | Engine.Input, Offer>,
    loans: Map<number, Model.Source>,
  ) {
    // The served engine queues for itself, and says where a recording stands in its queue.
    super({ concurrency: Infinity });
    this.#records = records;
    this.#asks = asks;
    this.#loans = loans;
  }

  /** Offer what the peer offers as of `offer`, unless a later offer came first. */
  follow(offer: Offer): void {
    if (offer.revision <= this.#revision) return;
    this.#revision = offer.revision;
    if (offer.reads) this.read ??= (model, file, signal) => this.#read(model, file, signal);
    const kept = new Set(offer.studies.map((study) => study.id));
    for (const [id, { withdraw }] of this.#mirrored) {
      if (kept.has(id)) continue;
      withdraw();
      this.#mirrored.delete(id);
    }
    for (const study of offer.studies) {
      const as = JSON.stringify(study);
      if (this.#mirrored.get(study.id)?.as !== as)
        this.#mirrored.set(study.id, { as, withdraw: this.offer(study) });
    }
  }

  protected parse(input: unknown): unknown {
    return input;
  }

  protected async execute(model: Model, input: unknown, recorder: Engine.Recorder): Promise<void> {
    const loan = this.#lend(model);
    try {
      for await (const item of this.#records.stream(
        { input, ...loan.request },
        { signal: recorder.signal },
      )) {
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
      loan.end();
    }
  }

  async #read(model: Model, file: Engine.File, signal?: AbortSignal): Promise<Engine.Input> {
    const loan = this.#lend(model);
    try {
      const reply = await this.#asks.call({ op: 'read', file, ...loan.request }, { signal });
      saved(reply, 'engine read reply');
      return reply;
    } finally {
      loan.end();
    }
  }

  /** Lend `model` for as long as one request lasts. */
  #lend(model: Model): { readonly request: Loan; end(): void } {
    const lent = ++this.#lent;
    this.#loans.set(lent, model.source());
    const home = homeOf(model);
    return {
      request: home === undefined ? { lent } : { lent, home },
      end: () => void this.#loans.delete(lent),
    };
  }
}

/**
 * The engine a `serveEngine` peer serves, once the studies it offers are in: it offers them too,
 * following each change, and answers `shown` and `problems` here. It records any model it is
 * given, a model the peer serves where it lives and any other through the source this side lends
 * while it records, and reads saved files when the peer's engine does. Closing it closes the
 * connection.
 *
 * @throws Error when the peer's engine cannot open, or offers a study that is not well formed.
 */
export async function connectEngine(port: Port, signal?: AbortSignal): Promise<Remote<Engine>> {
  const records = connect(port, RECORD);
  const asks = connect(port, STUDIES);
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
  const close = (): void => {
    records.close();
    asks.close();
    lending.close();
  };
  try {
    const engine = new Connected(records, asks, loans);
    // A change can overtake the reply to the first ask; the revision orders them.
    asks.on((offer) => {
      try {
        offered(offer, 'engine studies');
        engine.follow(offer);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    });
    const first = await asks.call({ op: 'studies' }, { signal });
    offered(first, 'engine studies');
    engine.follow(first);
    return Object.assign(engine, { close });
  } catch (error) {
    close();
    throw error;
  }
}
