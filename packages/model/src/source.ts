/**
 * A model as bytes: a core plus one shard per class, produced lazily and owned by whoever asks.
 * `sourceOf` packs a model on demand; `openModel` unpacks one, classes still lazy.
 */

import { createModel, type Model } from './model.js';
import { decodeCore, encodeCore } from './pack/core.js';
import { decodeShard, encodeShard } from './pack/shard.js';

/** Bytes-so-far progress for a core read. */
export type Progress = (loaded: number, total: number) => void;

/**
 * The same model as bytes.
 *
 * @remarks
 * Every buffer a source returns belongs to the caller; a transport may detach it. A source that
 * holds resources releases them in `close`, and the host closes the source, never the model.
 */
export interface Source {
  core(signal?: AbortSignal, progress?: Progress): Promise<Uint8Array>;
  class(id: string, signal?: AbortSignal): Promise<Uint8Array>;
  bytes(signal?: AbortSignal): Promise<Uint8Array>;
  close?(): void;
}

/** A source over a model, packing each part when asked. */
export function sourceOf(model: Model): Source {
  return {
    core: (signal) => {
      signal?.throwIfAborted();
      return Promise.resolve(encodeCore(model));
    },
    class: async (id, signal) => encodeShard(await model.load(id, signal)),
    bytes: async (signal) => (await model.bytes(signal)).slice(),
  };
}

/**
 * A model over a source, its classes unpacked as they load.
 *
 * @throws Error when the core is not a valid pack or describes an inconsistent model.
 */
export async function openModel(
  source: Source,
  options: { readonly signal?: AbortSignal; readonly progress?: Progress } = {},
): Promise<Model> {
  const core = decodeCore(await source.core(options.signal, options.progress));
  return createModel(core, {
    load: async (id, signal) => decodeShard(await source.class(id, signal)),
    bytes: (signal) => source.bytes(signal),
  });
}
