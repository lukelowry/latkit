/**
 * An engine served across a port: all of a vendor on one port. A peer lists the cases the engine
 * keeps and opens one as a session, each a document service of its own on the same port, so the
 * case stays where the engine holds it; it records any model with the engine, and each recording
 * is held where the engine runs, its frames in the engine's store. The peer follows a recording's
 * changes, its times and ranges, as they come, and reads the frames it draws a window at a time; it
 * lets a recording or a session go by closing it, and every one of them goes with the port. A
 * model the engine's realm serves, such as a session's, crosses by reference and is recorded where
 * it lives; any other is lent by its source, and a file by its bytes, which the engine reads only
 * as it needs. The studies and formats it offers cross with it, and follow it.
 */

import { Engine, Model, Recording, type Document, type Series } from '@latkit/model';

import { connect, serve, transferred, type Connection } from './channel.js';
import { check, type Check } from './check.js';
import { connectSession, serveSession } from './document.js';
import { token, version } from './document-protocol.js';
import { homed, homeOf, hosted } from './model.js';
import type { Port } from './port.js';
import { protocol } from './protocol.js';
import { owned, readWindow, WINDOW } from './recording.js';

/**
 * A model a peer lends: the key of the source it lends, and, for a model a realm serves, the token
 * that realm knows it by.
 */
interface Loan {
  readonly lent: number;
  readonly home?: string;
}

/** A file a peer lends: its name and size, and the key its bytes are read by. */
interface LentFile {
  readonly lent: number;
  readonly name: string;
  readonly size: number;
}

/** A recording a peer asks for: the number it knows the run by, the input, and the model it lends. */
interface Request extends Loan {
  readonly run: number;
  readonly input: unknown;
}

/** What a peer asks of a run: a window of its frames, or to let it go. */
type Run =
  | {
      readonly op: 'read';
      readonly run: number;
      readonly classId: string;
      readonly signalIndex: number;
      readonly window: Series.Window;
    }
  | { readonly op: 'release'; readonly run: number };

/** What a peer asks besides a recording: the studies offered, or the input a saved file holds. */
type Ask = { readonly op: 'studies' } | ({ readonly op: 'read'; readonly file: LentFile } & Loan);

/**
 * The studies an engine offers as of `revision`, which grows with each change, whether it reads
 * saved files, and the formats its cases are in.
 */
interface Offer {
  readonly revision: number;
  readonly studies: readonly Engine.Study[];
  readonly reads: boolean;
  readonly formats: readonly Engine.Format[];
}

/** What a peer asks of the cases: their names, a session on one, a new one, or to keep one. */
type Cases =
  | { readonly op: 'list' }
  | { readonly op: 'open'; readonly name: string }
  | {
      readonly op: 'create';
      readonly name: string;
      readonly title?: string;
      readonly file?: LentFile;
    }
  | { readonly op: 'save'; readonly name: string; readonly version: Document.Version };

/** A session the engine opened: the id of the document service it is on this port. */
interface Opened {
  readonly session: string;
}

/** One read of what a peer lends. */
type Borrow =
  | { readonly op: 'core'; readonly key: number }
  | { readonly op: 'class'; readonly key: number; readonly id: string }
  | { readonly op: 'bytes'; readonly key: number }
  | { readonly op: 'file'; readonly key: number; readonly start: number; readonly end: number };

/** An input is the served engine's to check: its own `parse` is the check. */
const input: Check<unknown> = () => undefined;

const loan = { lent: check.index, home: check.optional(check.string) };

const lentFile = check.object<LentFile>({
  lent: check.index,
  name: check.string,
  size: check.index,
});

const RECORD = protocol<Request, Recording.Change>(
  'engine:record',
  check.object<Request>({ run: check.index, input, ...loan }),
);

const RUNS = protocol<Run, Series.Block | undefined>(
  'engine:runs',
  check.requests<Run>({
    read: { run: check.index, classId: check.string, signalIndex: check.index, window: WINDOW },
    release: { run: check.index },
  }),
);

const STUDIES = protocol<Ask, Offer | Engine.Input, Offer>(
  'engine:studies',
  check.requests<Ask>({ studies: {}, read: { file: lentFile, ...loan } }),
);

const BORROW = protocol<Borrow, Uint8Array>(
  'engine:borrow',
  check.requests<Borrow>({
    core: { key: check.index },
    class: { key: check.index, id: check.string },
    bytes: { key: check.index },
    file: { key: check.index, start: check.index, end: check.index },
  }),
);

const CASES = protocol<Cases, readonly Engine.Case[] | Engine.Case | Opened>(
  'engine:cases',
  check.requests<Cases>({
    list: {},
    open: { name: check.string },
    create: {
      name: check.string,
      title: check.optional(check.string),
      file: check.optional(lentFile),
    },
    save: { name: check.string, version },
  }),
);

/** The most one read of a lent file carries. */
const SLICE = 4 << 20;

/** Studies one offer carries at most, and formats. */
const MAX_STUDIES = 4096;
const MAX_FORMATS = 256;
/** Cases one list carries at most. */
const MAX_CASES = 1_000_000;

/** A study as it crosses; the connected engine's `offer` checks its form. */
const study: Check<Engine.Study> = (value, name) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be a study`);
};

const format: Check<Engine.Format> = check.object<Engine.Format>({
  id: check.string,
  label: check.string,
  extensions: check.array(check.string, 64),
  creates: check.boolean,
});

const offered: Check<Offer> = check.object<Offer>({
  revision: check.index,
  studies: check.array(study, MAX_STUDIES),
  reads: check.boolean,
  formats: check.array(format, MAX_FORMATS),
});

const kept: Check<Engine.Case> = check.object<Engine.Case>({
  name: check.string,
  format: check.string,
  saved: check.nullable(version),
});

const listed: Check<readonly Engine.Case[]> = check.array(kept, MAX_CASES);

const opened: Check<Opened> = check.object<Opened>({ session: token });

const values: Check<Engine.Values> = (value, name) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be a map of values`);
};

const saved: Check<Engine.Input> = check.object<Engine.Input>({ study: check.string, values });

/**
 * Serve `engine` on `port` until either side closes: a peer lists and opens the cases it keeps,
 * records any model with it, and learns the studies and formats it offers, following each change.
 * Returns the server's own close; the engine itself stays open for its other peers.
 *
 * @remarks
 * An engine still opening is served once it opens. Each session a peer opens is served on this
 * port as a document of its own until the peer closes it. A model this realm serves with
 * `serveModel`, as every session's is, is recorded in place; any other is opened from the source
 * its peer lends, its classes read only as the engine asks for them. The engine checks every
 * input, queues what it cannot take at once, and stops a recording when its peer stops following
 * it. Each recording and session is held here until its peer lets it go or either side closes.
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
  /** Each recording the peer asked for, by its run, until the peer lets it go. */
  const recordings = new Map<number, Recording>();
  /** What ends each session the peer opened, by the id of its document service. */
  const sessions = new Map<string, () => void>();
  let revision = 0;
  let off = (): void => undefined;

  function close(): void {
    if (!served) return;
    served = null;
    off();
    records.close();
    runs.close();
    asks.close();
    cases.close();
    lent.close();
    for (const recording of recordings.values()) recording.close();
    recordings.clear();
    for (const end of [...sessions.values()]) end();
    sessions.clear();
    options.onClose?.();
  }

  /**
   * The model a peer lends: where this realm serves it, or opened from the source it lends, still
   * known by the realm it lives in, so a relay passes it on by reference.
   */
  async function modelOf({ lent: key, home }: Loan, signal: AbortSignal): Promise<Model> {
    const hosting = home === undefined ? undefined : hosted.get(home);
    return hosting ? await hosting : homed(await Model.from(borrowed(lent, key), { signal }), home);
  }

  const offer = (engine: Engine): Offer => ({
    revision,
    studies: engine.studies,
    reads: typeof engine.read === 'function',
    formats: engine.formats,
  });

  /** Serve `session` on this port as a document of its own; the id its peer connects it by. */
  function share(session: Document.Session, signal: AbortSignal): Opened {
    if (!served || signal.aborted) {
      session.close();
      throw new Error('The engine service closed before the case opened.');
    }
    const id = globalThis.crypto.randomUUID();
    sessions.set(id, serveSession(port, session, id, { onClose: () => sessions.delete(id) }));
    return { session: id };
  }

  const records = serve(
    port,
    RECORD,
    async function* ({ run, input, ...loan }, signal) {
      const engine = await current();
      const model = await modelOf(loan, signal);
      signal.throwIfAborted();
      if (recordings.has(run)) throw new Error(`run ${run} is already recorded`);
      const borrow = (value: unknown): unknown =>
        isLent(value) ? borrowedFile(lent, value) : value;
      const recording = engine.record(model, eachValue(input, borrow));
      recordings.set(run, recording);
      try {
        yield* owned(recording.source().changes(signal));
      } finally {
        // A peer that stops following stops the recording; one that ended stays until let go.
        recording.stop();
      }
    },
    { onClose: close },
  );

  const runs = serve(
    port,
    RUNS,
    (request, signal) => {
      const recording = recordings.get(request.run);
      if (request.op === 'release') {
        recordings.delete(request.run);
        recording?.close();
        return Promise.resolve(undefined);
      }
      if (!recording) return Promise.reject(new Error(`run ${request.run} was let go`));
      return readWindow(recording.source(), request, signal);
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
      return engine.read(await modelOf(request, signal), borrowedFile(lent, request.file), signal);
    },
    { onClose: close },
  );

  const cases = serve(
    port,
    CASES,
    async (request, signal) => {
      const engine = await current();
      switch (request.op) {
        case 'list':
          return engine.cases(signal);
        case 'save':
          return engine.save(request.name, request.version, signal);
        case 'open':
          return share(await engine.open(request.name, signal), signal);
        case 'create': {
          const { name, title, file } = request;
          if ((title === undefined) === (file === undefined))
            throw new TypeError('a new case is titled, or read from a file');
          const from = file ? { file: borrowedFile(lent, file) } : { title: title! };
          return share(await engine.create(name, from, signal), signal);
        }
      }
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

/** The file a peer lends, its bytes read across the port a slice at a time as they are asked for. */
function borrowedFile(
  lent: Connection<Borrow, Uint8Array>,
  { lent: key, name, size }: LentFile,
): Engine.File {
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const reply = await lent.call({ op: 'file', key, start, end });
    check.bytes(reply, 'engine file reply');
    return reply;
  };
  return {
    name,
    size,
    slice(start, end) {
      // File API uses Web IDL [Clamp]: round to nearest, ties to even. Clamp to the
      // file's extent first, since every offset beyond it selects the same endpoint.
      const offset = (value: number): number => {
        const bounded = Number.isNaN(value) ? 0 : Math.max(-size, Math.min(value, size));
        const floor = Math.floor(bounded);
        const integer = bounded - floor === 0.5 ? floor + Math.abs(floor % 2) : Math.round(bounded);
        return integer < 0 ? size + integer : integer;
      };
      const from = offset(start);
      const to = Math.max(from, offset(end));
      return {
        async arrayBuffer() {
          const bytes = new Uint8Array(to - from);
          for (let at = from; at < to; at += SLICE)
            bytes.set(await read(at, Math.min(at + SLICE, to)), at - from);
          return bytes.buffer;
        },
      };
    },
    stream() {
      let at = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (at >= size) return controller.close();
          const end = Math.min(at + SLICE, size);
          controller.enqueue(await read(at, end));
          at = end;
        },
      });
    },
  };
}

/**
 * `input` with `each` applied to every value its study gives it, a list's one by one: how the
 * files in it are lent, and borrowed. Any other input is as it is.
 */
function eachValue(input: unknown, each: (value: unknown) => unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const { values } = input as Partial<Engine.Input>;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return input;
  return {
    ...input,
    values: Object.fromEntries(
      Object.entries(values).map(([id, value]) => [
        id,
        Array.isArray(value) ? (value as readonly unknown[]).map(each) : each(value),
      ]),
    ),
  };
}

function isFile(value: unknown): value is Engine.File {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Engine.File).slice === 'function' &&
    typeof (value as Engine.File).stream === 'function'
  );
}

function isLent(value: unknown): value is LentFile {
  if (typeof value !== 'object' || value === null) return false;
  const { lent, name, size } = value as Partial<LentFile>;
  return Number.isSafeInteger(lent) && typeof name === 'string' && Number.isSafeInteger(size);
}

/**
 * An engine served elsewhere: it offers what its peer offers, its cases are the peer's, each open
 * one a session on the peer's document, and every recording is held there, lending the model it
 * records and the files its input gives.
 */
class Connected extends Engine {
  readonly #port: Port;
  readonly #records: Connection<Request, Recording.Change>;
  readonly #runs: Connection<Run, Series.Block | undefined>;
  readonly #asks: Connection<Ask, Offer | Engine.Input, Offer>;
  readonly #cases: Connection<Cases, readonly Engine.Case[] | Engine.Case | Opened>;
  /** What this side lends the peer while a request lasts, by key. */
  readonly #loans = new Map<number, Model.Source | Engine.File>();
  readonly #lending: { close(): void };
  /** Each study the peer offers, as it crossed, and what withdraws this engine's offer of it. */
  readonly #mirrored = new Map<string, { readonly as: string; readonly withdraw: () => void }>();
  #formats: readonly Engine.Format[] = [];
  #revision = -1;
  #lent = 0;
  #run = 0;

  constructor(port: Port) {
    // The served engine queues for itself, and says where a recording stands in its queue.
    super({ concurrency: Infinity });
    this.#port = port;
    this.#records = connect(port, RECORD);
    this.#runs = connect(port, RUNS);
    this.#asks = connect(port, STUDIES);
    this.#cases = connect(port, CASES);
    this.#lending = serve(port, BORROW, async (request, signal) => {
      const loaned = this.#loans.get(request.key);
      let data: Uint8Array;
      if (request.op === 'file') {
        if (!loaned || 'core' in loaned) throw new Error('the file is no longer lent');
        if (request.end - request.start > SLICE)
          throw new RangeError('a file read carries at most 4 MiB');
        data = new Uint8Array(await loaned.slice(request.start, request.end).arrayBuffer());
      } else {
        if (!loaned || !('core' in loaned)) throw new Error('the model is no longer lent');
        data =
          request.op === 'class'
            ? await loaned.class(request.id, signal)
            : request.op === 'core'
              ? await loaned.core(signal)
              : await loaned.bytes(signal);
      }
      return transferred(data, [data.buffer as ArrayBuffer]);
    });
  }

  /** Once the peer's first offer is in: what it offers, following each change after. */
  async opened(signal?: AbortSignal): Promise<void> {
    // A change can overtake the reply to the first ask; the revision orders them.
    this.#asks.on((offer) => {
      try {
        offered(offer, 'engine studies');
        this.#mirror(offer);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    });
    const first = await this.#asks.call({ op: 'studies' }, { signal });
    offered(first, 'engine studies');
    this.#mirror(first);
  }

  override get formats(): readonly Engine.Format[] {
    return this.#formats;
  }

  override async cases(signal?: AbortSignal): Promise<readonly Engine.Case[]> {
    const reply = await this.#cases.call({ op: 'list' }, { signal });
    listed(reply, 'engine cases');
    return reply;
  }

  override async open(name: string, signal?: AbortSignal): Promise<Document.Session> {
    return this.#session(await this.#cases.call({ op: 'open', name }, { signal }), signal);
  }

  override async create(
    name: string,
    from: { readonly title: string } | { readonly file: Engine.File },
    signal?: AbortSignal,
  ): Promise<Document.Session> {
    const loan = this.#loan();
    try {
      const request =
        'file' in from
          ? { op: 'create' as const, name, file: loan.file(from.file) }
          : { op: 'create' as const, name, title: from.title };
      return this.#session(await this.#cases.call(request, { signal }), signal);
    } finally {
      loan.end();
    }
  }

  override async save(
    name: string,
    version: Document.Version,
    signal?: AbortSignal,
  ): Promise<Engine.Case> {
    const reply = await this.#cases.call({ op: 'save', name, version }, { signal });
    kept(reply, 'engine saved case');
    return reply;
  }

  /** Stop what it follows, then hang up: the peer lets every recording and session go. */
  override close(): Promise<void> {
    const closing = super.close();
    this.#records.close();
    this.#runs.close();
    this.#asks.close();
    this.#cases.close();
    this.#lending.close();
    return closing;
  }

  /** The session the peer opened, connected on this port. */
  #session(
    reply: readonly Engine.Case[] | Engine.Case | Opened,
    signal?: AbortSignal,
  ): Promise<Document.Session> {
    opened(reply, 'engine session');
    return connectSession(this.#port, (reply as Opened).session, signal);
  }

  /** Offer what the peer offers as of `offer`, unless a later offer came first. */
  #mirror(offer: Offer): void {
    if (offer.revision <= this.#revision) return;
    this.#revision = offer.revision;
    this.#formats = Object.freeze(offer.formats.map((format) => Object.freeze({ ...format })));
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

  /** The recording the peer holds, followed here: it records nothing itself. */
  protected override begin(
    model: Model,
    input: unknown,
    header: { readonly id?: string; readonly label?: string },
  ): Recording {
    const run = ++this.#run;
    return Recording.follow(model, header, {
      changes: (signal) => this.#follow(run, model, input, signal),
      read: (classId, signalIndex, window, signal) =>
        this.#runs.call(
          { op: 'read', run, classId, signalIndex, window },
          { signal },
        ) as Promise<Series.Block>,
      close: () => void this.#runs.call({ op: 'release', run }).catch(() => undefined),
    });
  }

  protected execute(): Promise<void> {
    return Promise.reject(new Error('the peer records what a connected engine is asked to'));
  }

  /**
   * Have the peer record `model` for `input` as `run`, lending what it reads until the recording
   * ends, and follow it.
   */
  async *#follow(
    run: number,
    model: Model,
    input: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<Recording.Change> {
    const loan = this.#loan();
    try {
      const lent = eachValue(input, (value) => (isFile(value) ? loan.file(value) : value));
      for await (const change of this.#records.stream(
        { run, input: lent, ...loan.model(model) },
        { signal },
      )) {
        const status = (change as Partial<Recording.Change> | null)?.status;
        if (status !== 'waiting' && status !== 'recording') loan.end();
        yield change;
      }
    } finally {
      loan.end();
    }
  }

  async #read(model: Model, file: Engine.File, signal?: AbortSignal): Promise<Engine.Input> {
    const loan = this.#loan();
    try {
      const reply = await this.#asks.call(
        { op: 'read', file: loan.file(file), ...loan.model(model) },
        { signal },
      );
      saved(reply, 'engine read reply');
      return reply;
    } finally {
      loan.end();
    }
  }

  /**
   * Lend what one request needs, for as long as it lasts: a model by its source, known by the
   * realm it lives in when one serves it, and a file by its bytes.
   */
  #loan(): { model(model: Model): Loan; file(file: Engine.File): LentFile; end(): void } {
    const keys: number[] = [];
    const lend = (loaned: Model.Source | Engine.File): number => {
      const key = ++this.#lent;
      this.#loans.set(key, loaned);
      keys.push(key);
      return key;
    };
    return {
      model: (model) => {
        const lent = lend(model.source());
        const home = homeOf(model);
        return home === undefined ? { lent } : { lent, home };
      },
      file: (file) => ({ lent: lend(file), name: file.name, size: file.size }),
      end: () => {
        for (const key of keys) this.#loans.delete(key);
      },
    };
  }
}

/**
 * The engine a `serveEngine` peer serves, once the studies and formats it offers are in: it offers
 * them too, following each change, and answers `shown` and `problems` here. It lists the cases the
 * peer keeps, and each case it opens or creates is a session on the peer's document, over this
 * port. It records any model it is given, a model the peer serves where it lives, as a session's
 * is, and any other through the source this side lends while it records. Each recording is held by
 * the peer and followed here, its frames read a window at a time; closing a recording lets the
 * peer let it go. It reads saved files when the peer's engine does. Closing it stops what it
 * follows and closes the connection, every session on it with it.
 *
 * @throws Error when the peer's engine cannot open, or offers a study that is not well formed.
 */
export async function connectEngine(port: Port, signal?: AbortSignal): Promise<Engine> {
  const engine = new Connected(port);
  try {
    await engine.opened(signal);
    return engine;
  } catch (error) {
    void engine.close();
    throw error;
  }
}
