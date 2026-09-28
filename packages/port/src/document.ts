/**
 * Remote document editing over the same ports as models and engines. The owner is retained by
 * the document; a connected session owns its cached view, pending retry, and model leases.
 */
import { Document, DocumentConflict, Refusal, type Model } from '@latkit/model';

import {
  connect,
  serve,
  transferred,
  type Connection,
  type Remote,
  type Transferred,
} from './channel.js';
import {
  DOCUMENT,
  MAX_COMMAND_BYTES,
  checkReply,
  checkSchematicLengths,
  checkUpdate,
  publicInspection,
  sameVersion,
  type Command,
  type Receipt,
  type Reply,
  type Request,
  type Update,
} from './document-protocol.js';
import { ownerOf, Serial, type Owner } from './document-owner.js';
import { encodeFrame } from './frame.js';
import { connectModel, serveModel } from './model.js';
import type { Port } from './port.js';

const MAX_SNAPSHOTS = 32;

/**
 * Serve a document, retaining its owner and retry receipts across connections. One document
 * service occupies a port; model and engine services may share it. While served, mutate through
 * sessions so reads and edits share its queue. Acknowledgments are in-memory acceptance.
 *
 * @remarks
 * A factory runs on the first open request, at most once per service. Requests share its result
 * or failure. Supplied documents and promises retain eager initialization. Reuse the same document
 * across connections to retain its history and retry receipts.
 *
 * Closing releases this connection's model snapshots. It does not dispose the document or erase
 * its history, or cancel host-owned loading. A pending open cannot attach after closure. The host
 * owns document lifetime, authentication, and durable storage.
 */
export function serveDocument(
  port: Port,
  source: Document | Promise<Document> | (() => Document | Promise<Document>),
  options: { onClose?(): void } = {},
): () => void {
  let owner: Owner | null = null;
  let client: string | null = null;
  let off = (): void => undefined;
  let closed = false;
  let pending: Update | null = null;
  let flushing = false;
  const models = new Map<Model, { readonly id: string; readonly close: () => void }>();

  function assertOpen(): void {
    if (closed) throw new Error('The document service was closed.');
  }
  function acquire(document: Document): Owner {
    assertOpen();
    return ownerOf(document);
  }
  let opening: Promise<Owner> | undefined =
    typeof source === 'function' ? undefined : Promise.resolve(source).then(acquire);
  // Observe eager failures; requests still receive the original rejection.
  void opening?.catch(() => undefined);

  function openOwner(): Promise<Owner> {
    return (opening ??= Promise.resolve()
      .then(() => {
        assertOpen();
        return typeof source === 'function' ? source() : source;
      })
      .then(acquire));
  }

  function cleanup(): void {
    if (closed) return;
    closed = true;
    pending = null;
    off();
    if (client) owner?.detach(client, close);
    for (const snapshot of [...models.values()]) snapshot.close();
    models.clear();
    options.onClose?.();
  }
  function close(): void {
    service.close();
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
      close();
    } finally {
      flushing = false;
    }
  }
  function publish(update: Update): void {
    if (!port.drain) {
      service.emit(update);
      return;
    }
    // A slow peer retains only the newest update; a revision gap requests a fresh view.
    pending = update;
    if (!flushing) void flush();
  }

  const service = serve(
    port,
    DOCUMENT,
    async (request, signal) => {
      signal.throwIfAborted();
      assertOpen();
      if (client === null && request.op !== 'open')
        throw new Error('Open the document before using it.');
      const opened = await openOwner();
      signal.throwIfAborted();
      assertOpen();
      owner = opened;
      if (request.op === 'apply' || request.op === 'undo' || request.op === 'redo') {
        if (request.client !== client) throw new Error('Open this document client before editing.');
        return owner.commit(request, signal);
      }
      return owner.queue.run(async (): Promise<Reply | Transferred<Reply>> => {
        signal.throwIfAborted();
        const current = owner!;
        if (request.op === 'open') {
          if (client !== null) throw new Error('This document connection is already open.');
          const opened = current.open(request.client, close);
          client = opened.id;
          off = current.on(publish);
          return { kind: 'opened', client, next: opened.next, view: current.view };
        }
        if (request.op === 'view') return { kind: 'view', view: current.view };
        const version = current.view.version;
        if (!sameVersion(request.base, version)) return { kind: 'conflict', version };
        if (request.op === 'inspect') {
          const element =
            typeof request.target === 'string'
              ? current.document.find(request.target)
              : request.target;
          const inspected = element === null ? null : current.document.inspect(element);
          const inspection = inspected === null ? null : publicInspection(inspected);
          if (!sameVersion(version, current.view.version))
            return { kind: 'conflict', version: current.view.version };
          return { kind: 'inspection', version, inspection };
        }
        if (request.op === 'bytes') {
          const bytes = await current.document.bytes(signal);
          signal.throwIfAborted();
          if (!sameVersion(version, current.view.version))
            return { kind: 'conflict', version: current.view.version };
          return transferred<Reply>({ kind: 'bytes', version, bytes }, [
            bytes.buffer as ArrayBuffer,
          ]);
        }
        const model = await current.document.model(signal);
        signal.throwIfAborted();
        if (!sameVersion(version, current.view.version))
          return { kind: 'conflict', version: current.view.version };
        let snapshot = models.get(model);
        if (!snapshot) {
          if (models.size >= MAX_SNAPSHOTS)
            throw new Error('Close an old document model before opening another (limit 32).');
          const id = globalThis.crypto.randomUUID();
          const stop = serveModel(port, model, {
            id,
            onClose: () => {
              models.delete(model);
            },
          });
          snapshot = { id, close: stop };
          models.set(model, snapshot);
          signal.addEventListener('abort', stop, { once: true });
        }
        return { kind: 'model', version, id: snapshot.id };
      });
    },
    { onClose: cleanup },
  );
  return close;
}

type Calls = Connection<Request, Reply, Update>;
interface Snapshot {
  readonly promise: Promise<Remote<Model>>;
  readers: number;
  claimed: boolean;
  readonly controller: AbortController;
}
type Edit =
  | { readonly op: 'apply'; readonly operations: readonly Document.Operation[] }
  | { readonly op: 'undo' }
  | { readonly op: 'redo' };

/** The facade survives a reconnect; transport calls and model leases do not. */
class Connected implements Document.Session {
  readonly #queue = new Serial();
  readonly #listeners = new Set<(change: Document.Change) => void>();
  readonly #models = new Map<string, Snapshot>();
  #calls: Calls | null = null;
  #port: Port | null = null;
  #view: Document.View | null = null;
  #client: string | undefined;
  #next = 1;
  #pending: Command | null = null;
  #updates = Promise.resolve();
  #off = (): void => undefined;
  #closed = false;
  #attaching = false;
  #failure: Error | null = null;
  readonly #parts = Document.parts(() => this.view.schematic);

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

  async attach(port: Port, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error('The document session was closed.');
    if (this.#attaching) throw new Error('The document session is already connecting.');
    this.#attaching = true;
    this.#off();
    this.#calls?.close();
    try {
      // Settle the previous transport's work before assigning a replacement.
      await this.#queue.run(() => undefined);
      await this.#updates;
      if (this.#closed) throw new Error('The document session was closed.');
      for (const model of this.#models.values())
        void model.promise.then(
          (value) => value.close(),
          () => undefined,
        );
      this.#models.clear();
      this.#failure = null;
      this.#port = port;
      const calls = connect(port, DOCUMENT);
      this.#calls = calls;
      let ready = false;
      let overflow = false;
      const early: Update[] = [];
      this.#off = calls.on((update) => {
        if (ready) this.#receive(update, calls);
        else if (early.length < 256) early.push(update);
        else overflow = true;
      });
      const reply = await this.#ask(
        { op: 'open', ...(this.#client ? { client: this.#client } : {}) },
        signal,
      );
      if (this.#closed) throw new Error('The document session was closed.');
      if (reply.kind !== 'opened') throw new Error('Expected a document open reply.');
      this.#client = reply.client;
      this.#next = reply.next;
      this.#install(reply.view);
      ready = true;
      for (const update of early) this.#receive(update, calls);
      await this.#updates;
      if (overflow) await this.#refresh();
      // Recover the exact command whose acknowledgment may have been lost.
      if (this.#pending) await this.#send(this.#pending);
    } catch (error) {
      this.#off();
      this.#calls?.close();
      throw error;
    } finally {
      this.#attaching = false;
    }
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
    if (first && 'epoch' in first) return this.#edit({ op: 'apply', operations: rest }, first);
    return this.#edit({ op: 'apply', operations: first ? [first, ...rest] : rest });
  }
  undo(): Promise<Document.Change | null> {
    return this.#edit({ op: 'undo' });
  }
  redo(): Promise<Document.Change | null> {
    return this.#edit({ op: 'redo' });
  }

  #edit(edit: Edit, base: Document.Version = this.view.version): Promise<Document.Change | null> {
    // Capture indexes and their base together, before waiting behind another call.
    const draft = structuredClone({ ...edit, base });
    return this.#queue.run(async () => {
      this.#available();
      if (this.#pending) throw new Error('Reconnect the document to resolve its pending edit.');
      const command: Command = { ...draft, client: this.#client!, sequence: this.#next };
      DOCUMENT.check?.(command, 'document command');
      if (encodeFrame(command).byteLength > MAX_COMMAND_BYTES)
        throw new RangeError('A document command exceeds 1 MiB.');
      this.#pending = command;
      return this.#send(command);
    });
  }

  async #send(command: Command): Promise<Document.Change | null> {
    const reply = await this.#ask(command);
    if (!['accepted', 'conflict', 'refused', 'expired', 'busy'].includes(reply.kind))
      throw new Error('Expected a document edit receipt.');
    this.#pending = null;
    if (reply.kind !== 'busy') this.#next = Math.max(this.#next, command.sequence + 1);
    await this.#updates;
    const receipt = reply as Receipt;
    switch (receipt.kind) {
      case 'refused':
        throw new Refusal(receipt.message, receipt.at);
      case 'expired':
      case 'busy':
        throw new Error(receipt.message);
      case 'conflict':
        await this.#refresh();
        throw new DocumentConflict(command.base, receipt.version);
      case 'accepted':
        if (
          this.view.version.epoch !== receipt.version.epoch ||
          this.view.version.revision < receipt.version.revision
        )
          await this.#refresh();
        if (this.#failure !== null) throw this.#failure;
        return receipt.change;
    }
  }

  async inspect(
    target: Model.Element | string,
    signal?: AbortSignal,
  ): Promise<Document.InspectionResult> {
    this.#available();
    const request = structuredClone({ op: 'inspect' as const, base: this.view.version, target });
    DOCUMENT.check?.(request, 'document inspection request');
    const calls = this.#calls!;
    const reply = await this.#ask(request, signal);
    if (calls !== this.#calls || calls.closed !== null)
      throw new Error('The document disconnected.');
    if (reply.kind === 'conflict') {
      await this.#refresh();
      throw new DocumentConflict(request.base, reply.version);
    }
    if (reply.kind !== 'inspection') throw new Error('Expected a document inspection reply.');
    if (!sameVersion(request.base, reply.version))
      throw new Error('The document inspection does not match the requested revision.');
    return { version: reply.version, inspection: reply.inspection };
  }

  async model(signal?: AbortSignal): Promise<Document.Snapshot> {
    this.#available();
    const base = this.view.version;
    const calls = this.#calls!;
    const port = this.#port!;
    const reply = await this.#ask({ op: 'model', base }, signal);
    if (calls !== this.#calls || calls.closed !== null)
      throw new Error('The document disconnected.');
    if (reply.kind === 'conflict') {
      await this.#refresh();
      throw new DocumentConflict(base, reply.version);
    }
    if (reply.kind !== 'model') throw new Error('Expected a document model reply.');
    const id = reply.id;
    let snapshot = this.#models.get(id);
    if (!snapshot) {
      const controller = new AbortController();
      const promise = connectModel(port, { id, signal: controller.signal })
        .then((model) => {
          const close = model.close;
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

  on(_event: 'change', listener: (change: Document.Change) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
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
    this.#calls?.close();
    this.#listeners.clear();
    this.#pending = null;
  }

  #available(): void {
    if (this.#closed) throw new Error('The document session was closed.');
    if (this.#attaching) throw new Error('The document session is reconnecting.');
    if (this.#failure !== null) throw this.#failure;
    if (!this.#calls || this.#calls.closed !== null)
      throw new Error('The document disconnected; reconnect before continuing.');
  }

  async #ask(request: Request, signal?: AbortSignal): Promise<Reply> {
    const reply = await this.#calls!.call(request, { signal });
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
      this.#notify({ label: 'Refresh document', scope: 'structure', created: [] });
  }

  #receive(update: Update, calls: Calls): void {
    this.#updates = this.#updates
      .then(async () => {
        if (this.#calls !== calls || calls.closed !== null) return;
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
          schematic,
          palette: update.palette ?? current.palette,
          history: update.history,
        };
        this.#notify(update.change);
      })
      .catch((error: unknown) => {
        this.#failure = error instanceof Error ? error : new Error(String(error));
        calls.close();
      });
  }

  #notify(change: Document.Change): void {
    // Consumer callbacks must not turn an acknowledged edit into a failed mutation.
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch {
        /* A UI listener owns its errors. */
      }
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
 * Open a document session with a locally cached view. Pass the same facade as `resume` on a new
 * port to recover a lost acknowledgment before editing again. Pending edits keep their original
 * identity and base. Resuming an evicted client fails explicitly; it never retries as a new edit.
 *
 * @remarks
 * Up to 64 client identities are retained per live document, evicting detached clients first.
 * Each retains its latest receipt; older sequences are refused. Close model snapshots when done
 * (at most 32 live models per connection). Closing the session closes all of its snapshots.
 */
export async function connectDocument(
  port: Port,
  options: { readonly signal?: AbortSignal; readonly resume?: Remote<Document.Session> } = {},
): Promise<Remote<Document.Session>> {
  const session = options.resume ?? new Connected();
  if (!(session instanceof Connected))
    throw new TypeError('Resume a session created by connectDocument.');
  await session.attach(port, options.signal);
  return session;
}
