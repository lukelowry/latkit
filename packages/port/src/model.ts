/**
 * A model served across a port: its description and each class packed as they are asked for.
 * `connectModel` opens it on the far side, classes still lazy; only packs cross. Every model a realm
 * serves is known there by a token its peers carry, so an engine that realm serves records the
 * model where it lives.
 */

import { Model } from '@latkit/model';

import { connect, serve, transferred } from './channel.js';
import { check, type Check } from './check.js';
import type { Port } from './port.js';
import { protocol, type Progress } from './protocol.js';

type Request =
  | { readonly op: 'open' }
  | { readonly op: 'class'; readonly id: string }
  | { readonly op: 'bytes' };

/** What an open replies: the core, and the token the serving realm knows the model by. */
interface Opened {
  readonly core: Uint8Array;
  readonly home: string;
}

const modelProtocol = (id?: string) =>
  protocol<Request, Uint8Array | Opened>(
    id === undefined ? 'model' : `model:${id}`,
    check.requests<Request>({ open: {}, class: { id: check.string }, bytes: {} }),
  );

const opened: Check<Opened> = check.object<Opened>({ core: check.bytes, home: check.string });

/** Every model this realm serves, by the token its peers name it with. */
export const hosted = new Map<string, Promise<Model>>();

/** The token each model this realm connected to is served under, in the realm that serves it. */
const homes = new WeakMap<Model, string>();

/** The token `model`'s server knows it by, or undefined for a model no peer serves. */
export function homeOf(model: Model): string | undefined {
  return homes.get(model);
}

/**
 * `model`, known to live where a realm serves it as `home`: a model a relay borrows keeps the
 * token it arrived with, so the realm it lives in records it in place however many hops away.
 */
export function homed(model: Model, home: string | undefined): Model {
  if (home !== undefined) homes.set(model, home);
  return model;
}

/** A token no two served models in any realm share. */
function token(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Serve one model on `port` until either side closes. Returns the server's own close.
 *
 * @remarks
 * A model still opening is served once it opens, so no early request is lost. A model opened from
 * packs serves them as they came, so a relay forwards them untouched.
 *
 * @param options - `id` selects a scoped service; omitted, the name stays `model`.
 * `onClose` fires once the service has ended.
 */
export function serveModel(
  port: Port,
  model: Model | Promise<Model>,
  options: { readonly id?: string; onClose?(): void } = {},
): () => void {
  let served: Promise<Model> | null = Promise.resolve(model);
  // A rejected open is reported by the first request that awaits it.
  void served.catch(() => undefined);
  const home = token();
  hosted.set(home, served);
  const current = (): Promise<Model> =>
    served ?? Promise.reject(new Error('the served model was closed'));

  function close(): void {
    if (!served) return;
    served = null;
    hosted.delete(home);
    options.onClose?.();
  }

  const calls = serve(
    port,
    modelProtocol(options.id),
    async (request, signal, progress) => {
      const source = (await current()).source();
      const owned = (data: Uint8Array) => transferred(data, [data.buffer as ArrayBuffer]);
      switch (request.op) {
        case 'open': {
          const core = await source.core(signal, progress);
          return transferred<Opened>({ core, home }, [core.buffer as ArrayBuffer]);
        }
        case 'class':
          return owned(await source.class(request.id, signal));
        case 'bytes':
          return owned(await source.bytes(signal));
      }
    },
    { onClose: close },
  );

  return () => calls.close();
}

/**
 * Open the model a `serveModel` peer serves: its classes load across the port as they are asked
 * for. Closing the model closes the connection.
 *
 * @param options - `id` selects the matching scoped service; omit it for the default `model`.
 *
 * @throws Error when the peer cannot open the model, or serves an inconsistent one.
 */
export async function connectModel(
  port: Port,
  options: {
    readonly id?: string;
    readonly signal?: AbortSignal;
    readonly progress?: Progress;
  } = {},
): Promise<Model> {
  const calls = connect(port, modelProtocol(options.id));
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
    const model = await Model.from({
      core: () => Promise.resolve(reply.core),
      class: (id, signal) => ask({ op: 'class', id }, signal),
      bytes: (signal) => ask({ op: 'bytes' }, signal),
      close: () => calls.close(),
    });
    return homed(model, reply.home);
  } catch (error) {
    calls.close();
    throw error;
  }
}
