/**
 * A model as a source: its bytes, a core plus one shard per class, produced lazily and owned by
 * whoever asks, and its engine when it has one. `Model.source` makes one; `openModel` opens one,
 * classes still lazy.
 */

import { createModel, type Model } from './model.js';
import { decodeCore } from './pack/core.js';
import { decodeShard } from './pack/shard.js';
import type { RunUpdate } from './run.js';

/**
 * The same model as bytes, and its engine.
 *
 * @remarks
 * Every buffer a source returns belongs to the caller; a transport may detach it. A source that
 * holds resources releases them in `close`, and the host closes the source, never the model.
 */
export interface Source<Command = Uint8Array> {
  core(
    signal?: AbortSignal,
    progress?: (loaded: number, total: number) => void,
  ): Promise<Uint8Array>;
  class(id: string, signal?: AbortSignal): Promise<Uint8Array>;
  bytes(signal?: AbortSignal): Promise<Uint8Array>;
  /**
   * Run `command` against the model: where the run stands, blocks of frames, the solver's lines,
   * and one done, cancelled, or failed end. Absent when the model has no engine.
   */
  run?(command: Command, signal?: AbortSignal): AsyncIterable<RunUpdate>;
  close?(): void;
}

/**
 * A model over a source, its classes unpacked as they load, running on the source's engine.
 *
 * @throws Error when the core is not a valid pack or describes an inconsistent model.
 */
export async function openModel<Command = Uint8Array>(
  source: Source<Command>,
  options: {
    readonly signal?: AbortSignal;
    readonly progress?: (loaded: number, total: number) => void;
  } = {},
): Promise<Model<Command>> {
  const core = decodeCore(await source.core(options.signal, options.progress));
  const specs = new Map(core.classes.map((spec) => [spec.id, spec]));
  const run = source.run;
  return createModel<Command>({
    ...core,
    load: async (id, signal) => decodeShard(await source.class(id, signal), specs.get(id)!),
    bytes: (signal) => source.bytes(signal),
    ...(run && {
      run: (command: Command, signal: AbortSignal) => run.call(source, command, signal),
    }),
  });
}
