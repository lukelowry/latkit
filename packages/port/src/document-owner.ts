/**
 * One in-memory owner per document. Connections borrow it; disconnecting releases their model
 * services, not the document, revision, or bounded retry receipts.
 */
import { Document, Refusal } from '@latkit/model';

import { encodeFrame } from './frame.js';
import {
  MAX_COMMAND_BYTES,
  publicChange,
  sameVersion,
  type Command,
  type Receipt,
  type Update,
} from './document-protocol.js';

/** Detached clients are evicted first; an evicted identity can never start over at sequence one. */
const MAX_CLIENTS = 64;
const MAX_QUEUED = 256;
const MAX_QUEUED_BYTES = 8 << 20;
const KEYS = ['netlist', 'blocks', 'nets', 'sources', 'status', 'positions', 'problems'] as const;
const LAYOUT_KEYS = ['sources', 'status', 'positions', 'problems'] as const;

interface Client {
  next: number;
  last?: { readonly sequence: number; readonly hash: string; readonly reply: Receipt };
  close?: () => void;
}

class QueueFull extends Error {
  constructor() {
    super('The document queue is full.');
  }
}

/** Serial work with a bounded backlog; a rejected operation does not poison the queue. */
export class Serial {
  #tail = Promise.resolve();
  #waiting = 0;

  run<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.#waiting >= MAX_QUEUED) return Promise.reject(new QueueFull());
    this.#waiting++;
    const next = this.#tail.then(work);
    this.#tail = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#waiting--;
      });
    return next;
  }
}

/** Compare public columns, preserving unchanged buffers on both sides of the boundary. */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (
      !ArrayBuffer.isView(a) ||
      !ArrayBuffer.isView(b) ||
      Object.prototype.toString.call(a) !== Object.prototype.toString.call(b) ||
      a.byteLength !== b.byteLength
    )
      return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}

function historyOf(document: Document): Document['history'] {
  const { undo, redo } = document.history;
  return { undo: undo.map(publicChange), redo: redo.map(publicChange) };
}

/** Canonical key order makes a retry independent of an object's insertion order. */
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return (value as unknown[]).map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}
async function fingerprint(frame: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', frame as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class Owner {
  readonly queue = new Serial();
  readonly document: Document;
  readonly #clients = new Map<string, Client>();
  readonly #listeners = new Set<(update: Update) => void>();
  #view: Document.View;
  #failure: Error | null = null;
  #queuedBytes = 0;

  constructor(document: Document) {
    this.document = document;
    this.#view = {
      version: { epoch: globalThis.crypto.randomUUID(), revision: 0 },
      schematic: structuredClone(document.schematic),
      palette: structuredClone(document.palette),
      history: historyOf(document),
    };
    document.on('change', (change) => {
      try {
        this.#advance(change);
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
        for (const client of this.#clients.values()) client.close?.();
      }
    });
  }

  get view(): Document.View {
    if (this.#failure !== null) throw this.#failure;
    return this.#view;
  }

  open(id: string | undefined, close: () => void): { readonly id: string; readonly next: number } {
    let client = id === undefined ? undefined : this.#clients.get(id);
    if (id !== undefined && !client)
      throw new Error('The document client expired; open a new session.');
    if (!client) {
      if (this.#clients.size >= MAX_CLIENTS) {
        const detached = [...this.#clients].find(([, value]) => !value.close);
        if (!detached) throw new Error('The document already has 64 connected clients.');
        this.#clients.delete(detached[0]);
      }
      id = globalThis.crypto.randomUUID();
      client = { next: 1 };
    }
    client.close?.(); // A resumed client takes over its previous connection.
    client.close = close;
    this.#clients.delete(id!);
    this.#clients.set(id!, client);
    return { id: id!, next: client.next };
  }

  detach(id: string, close: () => void): void {
    const client = this.#clients.get(id);
    if (client?.close === close) client.close = undefined;
  }

  on(listener: (update: Update) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  commit(command: Command, signal: AbortSignal): Promise<Receipt> {
    // Size requests before retaining them behind a slow model capture.
    const frame = encodeFrame(canonical(command));
    if (frame.byteLength > MAX_COMMAND_BYTES)
      return Promise.reject(new RangeError('A document command exceeds 1 MiB.'));
    if (this.#queuedBytes + frame.byteLength > MAX_QUEUED_BYTES)
      return Promise.resolve({
        kind: 'busy',
        message: 'The document command backlog exceeds 8 MiB.',
      });
    this.#queuedBytes += frame.byteLength;
    return this.queue
      .run(async (): Promise<Receipt> => {
        signal.throwIfAborted(); // Once mutation begins, cancellation cannot roll it back.
        const client = this.#clients.get(command.client);
        if (!client) return { kind: 'expired', message: 'The document client expired.' };
        const hash = await fingerprint(frame);
        signal.throwIfAborted();
        if (client.last?.sequence === command.sequence) {
          if (client.last.hash !== hash)
            throw new Error('A document command identity was reused with another payload.');
          return client.last.reply; // Before the revision check, including refused/no-op commands.
        }
        if (command.sequence !== client.next)
          return {
            kind: 'expired',
            message: 'The document command is outside the retry window.',
          };

        let reply: Receipt;
        if (!sameVersion(command.base, this.view.version)) {
          reply = { kind: 'conflict', version: this.view.version };
        } else {
          try {
            const change =
              command.op === 'apply'
                ? this.document.apply(...command.operations)
                : command.op === 'undo'
                  ? this.document.undo()
                  : this.document.redo();
            reply = {
              kind: 'accepted',
              version: this.view.version,
              change: change && publicChange(change),
            };
          } catch (error) {
            if (!(error instanceof Refusal)) throw error;
            reply = { kind: 'refused', message: error.message, at: structuredClone(error.at) };
          }
        }
        client.last = { sequence: command.sequence, hash, reply };
        client.next++;
        return reply;
      })
      .catch((error: unknown): Receipt => {
        if (error instanceof QueueFull) return { kind: 'busy', message: error.message };
        throw error;
      })
      .finally(() => {
        this.#queuedBytes -= frame.byteLength;
      });
  }

  #advance(change: Document.Change): void {
    const from = this.#view.version;
    if (from.revision === Number.MAX_SAFE_INTEGER)
      throw new Error('The document revision is exhausted.');
    const to = { epoch: from.epoch, revision: from.revision + 1 };
    const current = this.document.schematic;
    const before = this.#view.schematic;
    const patch: Partial<Document.Schematic> = {};
    // A layout edit never changes the netlist or element indexing.
    for (const key of change.scope === 'layout' ? LAYOUT_KEYS : KEYS) {
      if (!equal(before[key], current[key]))
        Object.assign(patch, { [key]: structuredClone(current[key]) });
    }
    const palette = equal(this.#view.palette, this.document.palette)
      ? undefined
      : structuredClone(this.document.palette);
    const history = historyOf(this.document);
    const update: Update = {
      kind: 'update',
      from,
      to,
      change: publicChange(change),
      schematic: patch,
      ...(palette === undefined ? {} : { palette }),
      history,
    };
    this.#view = {
      version: to,
      schematic: Object.keys(patch).length === 0 ? before : { ...before, ...patch },
      palette: palette ?? this.#view.palette,
      history,
    };
    for (const listener of [...this.#listeners]) {
      try {
        listener(update);
      } catch {
        this.#listeners.delete(listener);
      } // A failed transport cannot undo a committed edit.
    }
  }
}

const owners = new WeakMap<Document, Owner>();
export function ownerOf(document: Document): Owner {
  let owner = owners.get(document);
  if (!owner) {
    owner = new Owner(document);
    owners.set(document, owner);
  }
  return owner;
}
