/**
 * A session on a document in the realm that holds it. Every call waits its turn in the document's
 * one queue, which every session on the document shares, so a read sees what the edits before it
 * made and an edit applies to the version its base names or not at all. Its view is the document
 * as it stands, and the version its engine last kept; a session across a port speaks the same
 * contract, a view cached on its side.
 */

import { Document, DocumentConflict } from './document.js';
import type { Model } from './model.js';

/** Calls one document lets wait at once; one more is refused until the queue drains. */
const MAX_WAITING = 256;

/** One document's calls, run one at a time in the order made; one that fails stops no other. */
class Queue {
  #tail: Promise<unknown> = Promise.resolve();
  #waiting = 0;

  run<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.#waiting >= MAX_WAITING)
      return Promise.reject(new Error('The document is busy; try again.'));
    this.#waiting++;
    const next = this.#tail.then(work);
    const done = (): void => {
      this.#waiting--;
    };
    this.#tail = next.then(done, done);
    return next;
  }
}

/** What an engine keeps of the case a session is on: the version it last kept, and each after. */
export interface Kept {
  readonly saved: Document.Version;
  on(listener: (version: Document.Version) => void): () => void;
}

const queues = new WeakMap<Document, Queue>();
const views = new WeakMap<Document, Document.View>();

/** The queue every session on `document` shares: its reads, its edits, and its saves. */
export function queueOf(document: Document): Queue {
  let queue = queues.get(document);
  if (!queue) {
    queue = new Queue();
    queues.set(document, queue);
  }
  return queue;
}

/**
 * `document` as a view, `saved` the version its engine last kept: one object per version and
 * keeping, so a view stays the same until the next step or save.
 */
function viewOf(document: Document, saved: Document.Version): Document.View {
  const version = document.version;
  let view = views.get(document);
  if (view?.version !== version || view.saved !== saved) {
    view = Object.freeze({
      version,
      saved,
      schematic: document.schematic,
      palette: document.palette,
      history: view?.version === version ? view.history : document.history,
    });
    views.set(document, view);
  }
  return view;
}

/** Whether two versions name one state of one document. */
export function sameVersion(a: Document.Version, b: Document.Version): boolean {
  return a.epoch === b.epoch && a.revision === b.revision;
}

/** A session on `document`, which its engine keeps as `kept` says; closing it lets `release` know, once. */
export class Local implements Document.Session {
  readonly #document: Document;
  readonly #kept: Kept;
  readonly #queue: Queue;
  readonly #release: () => void;
  readonly #changes = new Set<(change: Document.Change) => void>();
  readonly #saves = new Set<(version: Document.Version) => void>();
  readonly #parts = Document.parts(() => this.view.schematic);
  readonly #off: readonly (() => void)[];
  #closed = false;

  constructor(document: Document, kept: Kept, release: () => void) {
    this.#document = document;
    this.#kept = kept;
    this.#queue = queueOf(document);
    this.#release = release;
    this.#off = [
      document.on('change', (change) => tell(this.#changes, change)),
      kept.on((version) => tell(this.#saves, version)),
    ];
  }

  get view(): Document.View {
    return viewOf(this.#document, this.#kept.saved);
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
    const base = based ? first : this.view.version;
    let operations: Document.Operation[];
    try {
      // The operations as they are now: a caller may reuse its arrays once this returns.
      operations = structuredClone(based || first === undefined ? rest : [first, ...rest]);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new TypeError(String(error)));
    }
    return this.#run(base, () => this.#document.apply(...operations));
  }

  undo(): Promise<Document.Change | null> {
    return this.#run(this.view.version, () => this.#document.undo());
  }

  redo(): Promise<Document.Change | null> {
    return this.#run(this.view.version, () => this.#document.redo());
  }

  inspect(
    target: Model.Element | string,
    signal?: AbortSignal,
  ): Promise<Document.InspectionResult> {
    const base = this.view.version;
    const wanted =
      typeof target === 'string' ? target : { classId: target.classId, index: target.index };
    return this.#run(
      base,
      () => {
        const element = typeof wanted === 'string' ? this.#document.find(wanted) : wanted;
        return {
          version: base,
          inspection: element === null ? null : this.#document.inspect(element),
        };
      },
      signal,
    );
  }

  model(signal?: AbortSignal): Promise<Model> {
    const base = this.view.version;
    return this.#run(
      base,
      async () => {
        const model = await this.#document.model(signal);
        this.#at(base);
        return model;
      },
      signal,
    );
  }

  bytes(signal?: AbortSignal): Promise<Uint8Array> {
    const base = this.view.version;
    return this.#run(
      base,
      async () => {
        const bytes = await this.#document.bytes(signal);
        this.#at(base);
        return bytes;
      },
      signal,
    );
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
    for (const off of this.#off) off();
    this.#changes.clear();
    this.#saves.clear();
    this.#release();
  }

  /** Run `work` in the document's turn, once the document is still at `base`. */
  #run<T>(base: Document.Version, work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(closed());
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const queued = this.#queue.run(() => {
      if (this.#closed) throw closed();
      signal?.throwIfAborted();
      this.#at(base);
      return work();
    });
    return signal ? waitFor(queued, signal) : queued;
  }

  /** @throws DocumentConflict when the document is no longer at `base`. */
  #at(base: Document.Version): void {
    const version = this.#document.version;
    if (!sameVersion(base, version)) throw new DocumentConflict(base, version);
  }
}

/** Tell each of `listeners` of `event`; each owns its errors, so what happened stands. */
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

function closed(): Error {
  return new Error('The document session was closed.');
}

/** Why `signal` aborted, as an error. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

/** `promise`, or its caller's abort as soon as `signal` aborts; the work itself goes on. */
export function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
