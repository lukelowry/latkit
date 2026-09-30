/**
 * A case's document across a port: each session is a service of its own, `document:<id>`, on the
 * port of the engine that holds the case. The served side runs every call through the session it
 * serves, so a peer's edits and reads share the document's queue with every other session on it,
 * and tells its peer the schematic columns each step replaced. The connected side keeps the view
 * and answers local lookups without a call. A model a session captures crosses as a model service
 * of its own, so the engine beside it records it where it lives.
 */
import { Document, DocumentConflict, Refusal, type Model } from '@latkit/model';

import { connect, serve, transferred, type Connection, type Transferred } from './channel.js';
import {
  checkReply,
  checkSaved,
  checkSchematicLengths,
  checkUpdate,
  documentProtocol,
  publicChange,
  publicHistory,
  publicInspection,
  publicView,
  requests,
  sameVersion,
  type Event,
  type Reply,
  type Request,
  type Update,
} from './document-protocol.js';
import { connectModel, serveModel } from './model.js';
import type { Port } from './port.js';

/** Models one connection keeps served at once. */
const MAX_SNAPSHOTS = 32;
/** Updates a connection holds while it opens, before it knows the view they follow. */
const MAX_EARLY = 256;
/** The schematic columns a step may replace, and those a layout step may. */
const KEYS = ['netlist', 'blocks', 'nets', 'sources', 'status', 'positions', 'problems'] as const;
const LAYOUT_KEYS = ['sources', 'status', 'positions', 'problems'] as const;

/**
 * Serve `session` on `port` as document `id` until either side closes; the session closes with
 * the service. Returns the server's own close.
 */
export function serveSession(
  port: Port,
  session: Document.Session,
  id: string,
  options: { onClose?(): void } = {},
): () => void {
  let open = false;
  let closed = false;
  /** The view the peer has, as of the last update sent or waiting to be. */
  let told: Document.View | null = null;
  let pending: Update | null = null;
  let flushing = false;
  let off = (): void => undefined;
  const models = new Map<Model, { readonly id: string; readonly close: () => void }>();

  function cleanup(): void {
    if (closed) return;
    closed = true;
    pending = null;
    off();
    for (const snapshot of [...models.values()]) snapshot.close();
    models.clear();
    session.close();
    options.onClose?.();
  }

  async function flush(): Promise<void> {
    flushing = true;
    try {
      while (pending && !closed) {
        await port.drain?.();
        if (closed || !pending) break;
        const update = pending;
        pending = null;
        service.emit(update);
      }
    } catch {
      service.close();
    } finally {
      flushing = false;
    }
  }

  /** Tell the peer what `change` replaced. A slow peer keeps only the newest update; the revision
   *  gap it then sees makes it ask for the whole view. */
  function follow(change: Document.Change): void {
    const before = told!;
    const current = session.view;
    const schematic: Partial<Document.Schematic> = {};
    for (const key of change.scope === 'layout' ? LAYOUT_KEYS : KEYS)
      if (before.schematic[key] !== current.schematic[key])
        Object.assign(schematic, { [key]: current.schematic[key] });
    told = current;
    const update: Update = {
      kind: 'update',
      from: before.version,
      to: current.version,
      change: publicChange(change),
      schematic,
      ...(before.palette === current.palette ? {} : { palette: current.palette }),
      history: publicHistory(current.history),
    };
    if (!port.drain) {
      service.emit(update);
      return;
    }
    pending = update;
    if (!flushing) void flush();
  }

  /** What an edit's receipt says when it made `change`, or nothing, against `base`. */
  const accepted = (base: Document.Version, change: Document.Change | null): Reply => ({
    kind: 'accepted',
    version: change ? { epoch: base.epoch, revision: base.revision + 1 } : base,
    change: change && publicChange(change),
  });

  async function answer(
    request: Request,
    signal: AbortSignal,
  ): Promise<Reply | Transferred<Reply>> {
    if (request.op === 'open') {
      if (open) throw new Error('This document connection is already open.');
      open = true;
      told = session.view;
      const offChange = session.on('change', follow);
      const offSaved = session.on('saved', (version) => service.emit({ kind: 'saved', version }));
      off = () => {
        offChange();
        offSaved();
      };
      return { kind: 'opened', view: publicView(told) };
    }
    if (!open) throw new Error('Open the document before using it.');
    if (request.op === 'view') return { kind: 'view', view: publicView(session.view) };
    const base = request.base;
    const version = session.view.version;
    if (!sameVersion(base, version)) return { kind: 'conflict', version };
    // Each call below captures the view's revision, which is `base`, before anything can run.
    switch (request.op) {
      case 'apply':
        return accepted(base, await session.apply(base, ...request.operations));
      case 'undo':
        return accepted(base, await session.undo());
      case 'redo':
        return accepted(base, await session.redo());
      case 'inspect': {
        const { inspection } = await session.inspect(request.target, signal);
        return {
          kind: 'inspection',
          version: base,
          inspection: inspection && publicInspection(inspection),
        };
      }
      case 'bytes': {
        const bytes = await session.bytes(signal);
        return transferred<Reply>({ kind: 'bytes', version: base, bytes }, [
          bytes.buffer as ArrayBuffer,
        ]);
      }
      case 'model':
        return {
          kind: 'model',
          version: base,
          id: serveSnapshot(await session.model(signal), signal),
        };
    }
  }

  /** The id `model` is served under on this connection, served now unless it is. */
  function serveSnapshot(model: Model, signal: AbortSignal): string {
    const known = models.get(model);
    if (known) return known.id;
    if (models.size >= MAX_SNAPSHOTS)
      throw new Error('Close an old document model before opening another (limit 32).');
    const snapshot = globalThis.crypto.randomUUID();
    const close = serveModel(port, model, { id: snapshot, onClose: () => models.delete(model) });
    models.set(model, { id: snapshot, close });
    // A call cancelled before its reply leaves no service behind.
    signal.addEventListener('abort', close, { once: true });
    return snapshot;
  }

  const service = serve(
    port,
    documentProtocol(id),
    async (request, signal) => {
      signal.throwIfAborted();
      if (closed) throw new Error('The document service was closed.');
      try {
        return await answer(request, signal);
      } catch (error) {
        if (error instanceof DocumentConflict) return { kind: 'conflict', version: error.actual };
        if (
          error instanceof Refusal &&
          (request.op === 'apply' || request.op === 'undo' || request.op === 'redo')
        )
          return { kind: 'refused', message: error.message, at: structuredClone(error.at) };
        throw error;
      }
    },
    { onClose: cleanup },
  );
  return () => service.close();
}

type Calls = Connection<Request, Reply, Event>;
interface Snapshot {
  readonly promise: Promise<Model>;
  readers: number;
  claimed: boolean;
  readonly controller: AbortController;
}

/** A session across a port: its view kept here, its calls answered where the document is. */
class Connected implements Document.Session {
  readonly #port: Port;
  readonly #calls: Calls;
  readonly #changes = new Set<(change: Document.Change) => void>();
  readonly #saves = new Set<(version: Document.Version) => void>();
  readonly #models = new Map<string, Snapshot>();
  readonly #parts = Document.parts(() => this.view.schematic);
  #view: Document.View | null = null;
  #updates = Promise.resolve();
  #off = (): void => undefined;
  #closed = false;
  #failure: Error | null = null;

  constructor(port: Port, id: string) {
    this.#port = port;
    this.#calls = connect(port, documentProtocol(id));
  }

  get view(): Document.View {
    if (!this.#view) throw new Error('The document has not opened.');
    return this.#view;
  }

  elementAt(part: Document.Part): Model.Element | null {
    return this.#parts.elementAt(part);
  }
  partOf(element: Model.Element): Document.Part | null {
    return this.#parts.partOf(element);
  }
  portAt(index: number): Document.Port {
    return this.#parts.portAt(index);
  }
  portOf(port: Document.Port): number | null {
    return this.#parts.portOf(port);
  }
  drivers(ref: Model.FieldRef): Uint32Array {
    return this.#parts.drivers(ref);
  }

  async open(signal?: AbortSignal): Promise<void> {
    const calls = this.#calls;
    let ready = false;
    let overflow = false;
    const early: Event[] = [];
    this.#off = calls.on((event) => {
      if (ready) this.#receive(event);
      else if (early.length < MAX_EARLY) early.push(event);
      else overflow = true;
    });
    const reply = await this.#ask({ op: 'open' }, signal);
    if (reply.kind !== 'opened') throw new Error('Expected a document open reply.');
    this.#install(reply.view);
    ready = true;
    for (const event of early) this.#receive(event);
    await this.#updates;
    if (overflow) await this.#refresh();
  }

  apply(...operations: Document.Operation[]): Promise<Document.Change | null>;
  apply(
    base: Document.Version,
    ...operations: Document.Operation[]
  ): Promise<Document.Change | null>;
  apply(
    first?: Document.Version | Document.Operation,
    ...rest: Document.Operation[]
  ): Promise<Document.Change | null> {
    const based = first !== undefined && 'epoch' in first;
    const operations = based || first === undefined ? rest : [first, ...rest];
    return this.#edit((base) => ({ op: 'apply', base, operations }), based ? first : undefined);
  }
  undo(): Promise<Document.Change | null> {
    return this.#edit((base) => ({ op: 'undo', base }));
  }
  redo(): Promise<Document.Change | null> {
    return this.#edit((base) => ({ op: 'redo', base }));
  }

  /** Send the edit `make` makes against `base`, the view's revision when absent, captured now. */
  async #edit(
    make: (base: Document.Version) => Extract<Request, { op: 'apply' | 'undo' | 'redo' }>,
    base?: Document.Version,
  ): Promise<Document.Change | null> {
    this.#available();
    // Capture indexes and their base together, before anything else can run.
    const request = structuredClone(make(base ?? this.view.version));
    requests(request, 'document edit');
    const reply = await this.#ask(request);
    await this.#updates;
    switch (reply.kind) {
      case 'refused':
        throw new Refusal(reply.message, reply.at);
      case 'conflict':
        await this.#refresh();
        throw new DocumentConflict(request.base, reply.version);
      case 'accepted':
        if (
          this.view.version.epoch !== reply.version.epoch ||
          this.view.version.revision < reply.version.revision
        )
          await this.#refresh();
        if (this.#failure !== null) throw this.#failure;
        return reply.change;
      default:
        throw new Error('Expected a document edit receipt.');
    }
  }

  async inspect(
    target: Model.Element | string,
    signal?: AbortSignal,
  ): Promise<Document.InspectionResult> {
    this.#available();
    const request = structuredClone({ op: 'inspect' as const, base: this.view.version, target });
    requests(request, 'document inspection request');
    const reply = await this.#ask(request, signal);
    if (reply.kind === 'conflict') {
      await this.#refresh();
      throw new DocumentConflict(request.base, reply.version);
    }
    if (reply.kind !== 'inspection') throw new Error('Expected a document inspection reply.');
    if (!sameVersion(request.base, reply.version))
      throw new Error('The document inspection does not match the requested revision.');
    return { version: reply.version, inspection: reply.inspection };
  }

  async model(signal?: AbortSignal): Promise<Model> {
    this.#available();
    const base = this.view.version;
    const reply = await this.#ask({ op: 'model', base }, signal);
    if (reply.kind === 'conflict') {
      await this.#refresh();
      throw new DocumentConflict(base, reply.version);
    }
    if (reply.kind !== 'model') throw new Error('Expected a document model reply.');
    const id = reply.id;
    let snapshot = this.#models.get(id);
    if (!snapshot) {
      const controller = new AbortController();
      const promise = connectModel(this.#port, { id, signal: controller.signal })
        .then((model) => {
          // Closing it forgets it here too, so the next capture of the same model connects again.
          const close = model.close.bind(model);
          return Object.assign(model, {
            close: () => {
              if (this.#models.get(id)?.promise === promise) this.#models.delete(id);
              close();
            },
          });
        })
        .catch((error: unknown) => {
          if (this.#models.get(id)?.promise === promise) this.#models.delete(id);
          throw error;
        });
      snapshot = { promise, readers: 0, claimed: false, controller };
      this.#models.set(id, snapshot);
    }
    snapshot.readers++;
    try {
      const model = await waitFor(snapshot.promise, signal);
      signal?.throwIfAborted();
      snapshot.claimed = true;
      return model;
    } finally {
      snapshot.readers--;
      // An aborted reader must neither leak an unclaimed lease nor close another reader's model.
      if (!snapshot.claimed && snapshot.readers === 0) {
        snapshot.controller.abort();
        void snapshot.promise.then(
          (model) => model.close(),
          () => undefined,
        );
      }
    }
  }

  async bytes(signal?: AbortSignal): Promise<Uint8Array> {
    this.#available();
    const base = this.view.version;
    const reply = await this.#ask({ op: 'bytes', base }, signal);
    if (reply.kind === 'conflict') {
      await this.#refresh();
      throw new DocumentConflict(base, reply.version);
    }
    if (reply.kind !== 'bytes') throw new Error('Expected document bytes.');
    return reply.bytes;
  }

  on(event: 'change', listener: (change: Document.Change) => void): () => void;
  on(event: 'saved', listener: (version: Document.Version) => void): () => void;
  on(
    event: 'change' | 'saved',
    listener: ((change: Document.Change) => void) | ((version: Document.Version) => void),
  ): () => void {
    const listeners = (event === 'saved' ? this.#saves : this.#changes) as Set<typeof listener>;
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#off();
    for (const model of this.#models.values())
      void model.promise.then(
        (value) => value.close(),
        () => undefined,
      );
    this.#models.clear();
    this.#calls.close();
    this.#changes.clear();
    this.#saves.clear();
  }

  #available(): void {
    if (this.#closed) throw new Error('The document session was closed.');
    if (this.#failure !== null) throw this.#failure;
    if (this.#calls.closed !== null) throw new Error('The document disconnected.');
  }

  async #ask(request: Request, signal?: AbortSignal): Promise<Reply> {
    const reply = await this.#calls.call(request, { signal });
    checkReply(reply, 'document reply');
    return reply;
  }

  async #refresh(): Promise<void> {
    const reply = await this.#ask({ op: 'view' });
    if (reply.kind !== 'view') throw new Error('Expected a document view.');
    this.#install(reply.view);
  }

  #install(view: Document.View): void {
    const previous = this.#view;
    if (
      previous &&
      previous.version.epoch === view.version.epoch &&
      previous.version.revision > view.version.revision
    )
      return;
    this.#view = view;
    if (previous && !sameVersion(previous.version, view.version))
      tell(this.#changes, { label: 'Refresh document', scope: 'structure', created: [] });
    if (previous && !sameVersion(previous.saved, view.saved)) tell(this.#saves, view.saved);
  }

  /** Take `event` in turn after those before it: a version the engine kept, or a step. */
  #receive(event: Event): void {
    const calls = this.#calls;
    this.#updates = this.#updates
      .then(async () => {
        if (calls.closed !== null) return;
        if (event.kind === 'saved') {
          checkSaved(event, 'document saved event');
          this.#view = { ...this.view, saved: event.version };
          tell(this.#saves, event.version);
          return;
        }
        const update: Update = event;
        checkUpdate(update, 'document update');
        if (
          update.from.epoch !== update.to.epoch ||
          update.to.revision !== update.from.revision + 1
        )
          throw new Error('Invalid document update version.');
        let current = this.view;
        if (
          current.version.epoch === update.to.epoch &&
          current.version.revision >= update.to.revision
        )
          return;
        if (!sameVersion(current.version, update.from)) {
          await this.#refresh();
          current = this.view;
          if (
            current.version.epoch === update.to.epoch &&
            current.version.revision >= update.to.revision
          )
            return;
          if (!sameVersion(current.version, update.from))
            throw new Error('The document update does not follow its view.');
        }
        const schematic =
          Object.keys(update.schematic).length === 0
            ? current.schematic
            : { ...current.schematic, ...update.schematic };
        checkSchematicLengths(schematic);
        this.#view = {
          version: update.to,
          saved: current.saved,
          schematic,
          palette: update.palette ?? current.palette,
          history: update.history,
        };
        tell(this.#changes, update.change);
      })
      .catch((error: unknown) => {
        this.#failure = error instanceof Error ? error : new Error(String(error));
        calls.close();
      });
  }
}

/** Tell each of `listeners` of `event`: a listener's failure must not turn an accepted edit into a
 *  failed one, so each owns its errors. */
function tell<T>(listeners: ReadonlySet<(event: T) => void>, event: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function aborted(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

/** Cancel one reader promptly without cancelling a shared model open for other readers. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(aborted(signal));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * The session `serveSession` serves on `port` as document `id`, its view cached here once this
 * resolves. Closing it closes its models, and the session where the document is.
 */
export async function connectSession(
  port: Port,
  id: string,
  signal?: AbortSignal,
): Promise<Document.Session> {
  const session = new Connected(port, id);
  try {
    await session.open(signal);
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}
