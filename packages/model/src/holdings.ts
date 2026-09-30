/**
 * What an engine holds of its cases: the formats they are in, the store that keeps them, and the
 * one document it holds open on each case in use. Every session on a case shares that document; a
 * document with unsaved edits stays open, and clean ones no session holds stay open while their
 * cases' bytes fit a budget, the least recently opened let go first, so reopening one is instant.
 * A save runs in the document's queue, so it keeps exactly the version it names.
 */

import { DocumentConflict, type Document } from './document.js';
import type { Engine } from './engine.js';
import { Local, queueOf, sameVersion, waitFor, type Kept } from './session.js';

/**
 * A document open on a case: the version it last saved, which every session on it hears of, and
 * what the store holds of it.
 */
class Open implements Kept {
  saved: Document.Version;
  readonly #heard = new Set<(version: Document.Version) => void>();

  constructor(
    readonly document: Document,
    /** What the store named the case's content when it last read or wrote it. */
    public tag: string,
    /** The case's size in bytes as last read or written: what it counts for while idle. */
    public size: number,
  ) {
    this.saved = document.version;
  }

  on(listener: (version: Document.Version) => void): () => void {
    this.#heard.add(listener);
    return () => void this.#heard.delete(listener);
  }

  /** The store keeps `version` as `tag`, `size` bytes: every session on the document hears. */
  keep(version: Document.Version, tag: string, size: number): void {
    this.saved = version;
    this.tag = tag;
    this.size = size;
    for (const listener of [...this.#heard]) listener(version);
  }
}

/** A case held open: once open, its document; and the sessions on it, and saves in flight. */
interface Held {
  readonly opening: Promise<Open>;
  open: Open | null;
  users: number;
}

const byName = (a: Engine.Case, b: Engine.Case): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export class Holdings {
  readonly formats: readonly Engine.Format[];
  readonly #native: readonly Document.Format[];
  readonly #store: Engine.Cases | null;
  readonly #idleBytes: number;
  /** Each case held open, by name, the least recently opened first. */
  readonly #held = new Map<string, Held>();
  /** Every session still open on one of its cases. */
  readonly #sessions = new Set<Local>();
  #closed = false;

  /**
   * @throws Error when two formats share an id, one claims no extension, or two claim one.
   */
  constructor(formats: readonly Document.Format[], store: Engine.Cases | null, idleBytes: number) {
    const ids = new Set<string>();
    const extensions = new Set<string>();
    for (const format of formats) {
      if (typeof format.id !== 'string' || format.id === '' || ids.has(format.id))
        throw new Error(`format ids must be non-empty and unique: '${String(format.id)}'`);
      ids.add(format.id);
      if (!Array.isArray(format.extensions as unknown) || format.extensions.length === 0)
        throw new Error(`format '${format.id}' claims no extension`);
      for (const extension of format.extensions) {
        if (typeof extension !== 'string' || extension === '' || extensions.has(extension))
          throw new Error(`extension '${String(extension)}' must be non-empty and one format's`);
        extensions.add(extension);
      }
    }
    if (!(idleBytes >= 0)) throw new RangeError('an idle budget is a nonnegative number of bytes');
    this.#native = formats;
    this.#store = store;
    this.#idleBytes = idleBytes;
    this.formats = Object.freeze(
      formats.map(({ id, label, extensions, create }) =>
        Object.freeze({
          id,
          label,
          extensions: Object.freeze([...extensions]),
          creates: typeof create === 'function',
        }),
      ),
    );
  }

  async list(signal?: AbortSignal): Promise<readonly Engine.Case[]> {
    if (this.#closed) throw new Error('The engine was closed.');
    if (!this.#store) return [];
    const names = await this.#store.list(signal);
    signal?.throwIfAborted();
    const cases: Engine.Case[] = [];
    for (const name of names) {
      const format = this.#formatOf(name);
      if (format) cases.push(this.#case(name, format));
    }
    return cases.sort(byName);
  }

  open(name: string, signal?: AbortSignal): Promise<Document.Session> {
    const store = this.#usable();
    const format = this.#required(name);
    const held =
      this.#held.get(name) ??
      this.#hold(
        name,
        (async (): Promise<Open> => {
          // One open serves every session that asks, so no one session's signal cancels it.
          const { bytes, tag } = await store.read(name);
          return new Open(await format.open(bytes), tag, bytes.byteLength);
        })(),
      );
    return this.#session(name, held, signal);
  }

  create(
    name: string,
    from: { readonly title: string } | { readonly file: Engine.File },
    signal?: AbortSignal,
  ): Promise<Document.Session> {
    const store = this.#usable();
    const format = this.#required(name);
    if (this.#held.has(name)) return Promise.reject(new Error(`A case named ${name} exists.`));
    if ('file' in from ? !isFile(from.file) : typeof from.title !== 'string')
      return Promise.reject(new TypeError('a new case is titled, or read from a file'));
    const make = format.create?.bind(format);
    if (!('file' in from) && !make)
      return Promise.reject(new Error(`${format.label} cannot create a case.`));
    // Held before any work, so an open that overlaps the creation shares its document.
    const held = this.#hold(
      name,
      (async (): Promise<Open> => {
        const document =
          'file' in from
            ? await format.open(await bytesOf(from.file, signal), signal)
            : await make!(from.title, signal);
        const bytes = await document.bytes(signal);
        return new Open(document, await store.write(name, bytes, null, signal), bytes.byteLength);
      })(),
    );
    return this.#session(name, held, signal);
  }

  async save(name: string, version: Document.Version, signal?: AbortSignal): Promise<Engine.Case> {
    const store = this.#usable();
    const format = this.#required(name);
    const held = this.#held.get(name);
    const open = held?.open;
    if (!held || !open) throw new Error(`The case ${name} is not open.`);
    held.users++;
    try {
      return await waitFor(
        queueOf(open.document).run(async () => {
          signal?.throwIfAborted();
          const at = (): void => {
            const current = open.document.version;
            if (!sameVersion(version, current)) throw new DocumentConflict(version, current);
          };
          at();
          const bytes = await open.document.bytes(signal);
          at();
          open.keep(version, await store.write(name, bytes, open.tag, signal), bytes.byteLength);
          return this.#case(name, format);
        }),
        signal,
      );
    } finally {
      this.#let(held);
    }
  }

  /** Close every session, let every case go, and resolve once the work on each is done. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const session of [...this.#sessions]) session.close();
    const held = [...this.#held.values()];
    this.#held.clear();
    await Promise.allSettled(
      held.map(({ opening }) =>
        opening.then((open) => queueOf(open.document).run(() => undefined)),
      ),
    );
  }

  #usable(): Engine.Cases {
    if (this.#closed) throw new Error('The engine was closed.');
    if (!this.#store) throw new Error('The engine keeps no cases.');
    return this.#store;
  }

  /** The format case `name` is in: the one whose extension it ends with, the longest first. */
  #formatOf(name: string): Document.Format | undefined {
    let found: Document.Format | undefined;
    let longest = 0;
    for (const format of this.#native)
      for (const extension of format.extensions)
        if (extension.length > longest && name.endsWith(extension)) {
          found = format;
          longest = extension.length;
        }
    return found;
  }

  #required(name: string): Document.Format {
    if (typeof name !== 'string' || name === '') throw new TypeError('a case has a name');
    const format = this.#formatOf(name);
    if (!format) throw new Error(`No format opens ${name}.`);
    return format;
  }

  #case(name: string, format: Document.Format): Engine.Case {
    return { name, format: format.id, saved: this.#held.get(name)?.open?.saved ?? null };
  }

  /** Hold case `name` open with what `opening` opens, forgetting it if it does not open. */
  #hold(name: string, opening: Promise<Open>): Held {
    const held: Held = { opening, open: null, users: 0 };
    this.#held.set(name, held);
    void opening.then(
      (open) => {
        held.open = open;
        this.#trim();
      },
      () => {
        if (this.#held.get(name) === held) this.#held.delete(name);
      },
    );
    return held;
  }

  /** A session on `held`, once it opens; the most recently opened case goes last to be let go. */
  async #session(name: string, held: Held, signal?: AbortSignal): Promise<Document.Session> {
    held.users++;
    this.#held.delete(name);
    this.#held.set(name, held);
    let open: Open;
    try {
      open = await waitFor(held.opening, signal);
    } catch (error) {
      this.#let(held);
      throw error;
    }
    if (this.#closed) {
      this.#let(held);
      throw new Error('The engine was closed.');
    }
    const session: Local = new Local(open.document, open, () => {
      this.#sessions.delete(session);
      this.#let(held);
    });
    this.#sessions.add(session);
    return session;
  }

  #let(held: Held): void {
    held.users--;
    this.#trim();
  }

  /**
   * Let go of the least recently opened clean cases no one uses until those kept idle fit the
   * budget; unsaved edits keep a case. Synchronous, so no session begins in between.
   */
  #trim(): void {
    let idle = 0;
    for (const [name, { users, open }] of [...this.#held].reverse()) {
      if (users > 0 || open === null || !sameVersion(open.saved, open.document.version)) continue;
      idle += open.size;
      if (idle > this.#idleBytes) this.#held.delete(name);
    }
  }
}

function isFile(value: unknown): value is Engine.File {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Engine.File).slice === 'function' &&
    typeof (value as Engine.File).stream === 'function' &&
    Number.isSafeInteger((value as Engine.File).size)
  );
}

/** Every byte of `file`. */
async function bytesOf(file: Engine.File, signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
  signal?.throwIfAborted();
  return bytes;
}
