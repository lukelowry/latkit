/**
 * A model source and its runner as port services. Only bytes cross: the core, class shards, and
 * the vendor source. A run is one stream call: the runner's updates are its items, and cancelling
 * the stream aborts the runner.
 */

import type { Runner, RunUpdate, Source } from '@latkit/model';
import { connect, type Port, protocol, serve, transferred } from '@latkit/port';
import { bytes, requests, str, type Guard } from '@latkit/port/guard';

import type { Remote } from './remote.js';

/** What one side serves: a source and, when it has an engine, a runner. */
export interface Served<Command = Uint8Array> {
  readonly source: Source;
  readonly runner?: Runner<Command>;
}

type Request =
  | { readonly op: 'hello' }
  | { readonly op: 'core' }
  | { readonly op: 'class'; readonly id: string }
  | { readonly op: 'bytes' };

type Reply = Uint8Array | { readonly runnable: boolean };

const SOURCE = protocol<Request, Reply>(
  'source',
  requests<Request>({ hello: {}, core: {}, class: { id: str }, bytes: {} }),
);
const RUN = 'source:run';

/** A remote run's updates, ended with `cancelled` when an abort stops the stream first. */
async function* settled(
  updates: AsyncIterable<RunUpdate>,
  signal: AbortSignal | undefined,
): AsyncGenerator<RunUpdate> {
  let ended = false;
  for await (const update of updates) {
    ended = update.type === 'done' || update.type === 'cancelled' || update.type === 'failed';
    yield update;
  }
  if (!ended && signal?.aborted) yield { type: 'cancelled' };
}

/**
 * Serve one model on `port` until either side closes. Returns the server's own close.
 *
 * @param options - `command` guards what the peer sends a run, since the peer is untrusted; it
 * defaults to bytes, and a structured command needs its own. `onClose` fires once the service has
 * ended.
 */
export function serveSource<Command = Uint8Array>(
  port: Port,
  initial: Served<Command> | Promise<Served<Command>>,
  options: { readonly command?: Guard<Command>; onClose?(): void } = {},
): () => void {
  let served: Promise<Served<Command>> | null = Promise.resolve(initial);
  // A rejected open is reported by the first request that awaits it.
  void served.catch(() => undefined);
  let running = false;
  const current = (): Promise<Served<Command>> =>
    served ?? Promise.reject(new Error('the served model was closed'));

  function close(): void {
    const closing = served;
    if (!closing) return;
    served = null;
    void closing.then(
      (entry) => entry.source.close?.(),
      () => undefined,
    );
    options.onClose?.();
  }

  const calls = serve(
    port,
    SOURCE,
    async (request, signal, progress) => {
      const entry = await current();
      const owned = (data: Uint8Array) => transferred<Reply>(data, [data.buffer as ArrayBuffer]);
      switch (request.op) {
        case 'hello':
          return { runnable: entry.runner !== undefined };
        case 'core':
          return owned(await entry.source.core(signal, progress));
        case 'class':
          return owned(await entry.source.class(request.id, signal));
        case 'bytes':
          return owned(await entry.source.bytes(signal));
      }
    },
    { onClose: close },
  );

  const run = protocol<Command, RunUpdate>(RUN, options.command ?? (bytes as Guard<Command>));
  const runs = serve(port, run, async function* (command, signal) {
    const entry = await current();
    if (!entry.runner) throw new Error('this source cannot run');
    if (running) throw new Error('a run is already in progress');
    running = true;
    try {
      yield* entry.runner.run(command, signal);
    } finally {
      running = false;
    }
  });

  return () => {
    calls.close();
    runs.close();
  };
}

/** Connect to the model a `serveSource` peer serves. Closing the remote closes the connection. */
export async function connectSource<Command = Uint8Array>(
  port: Port,
): Promise<Remote<Served<Command>>> {
  const calls = connect(port, SOURCE);
  const runs = connect(port, protocol<Command, RunUpdate>(RUN));
  const ask = async (
    request: Request,
    signal?: AbortSignal,
    progress?: (loaded: number, total: number) => void,
  ): Promise<Uint8Array> => {
    const reply = await calls.call(request, { signal, progress });
    if (!bytes(reply)) throw new Error('malformed source reply');
    return reply;
  };

  let hello: Reply;
  try {
    hello = await calls.call({ op: 'hello' });
  } catch (error) {
    calls.close();
    runs.close();
    throw error;
  }
  // The caller keeps every command it passes in: a command is small enough to copy, and a run may
  // be started again from the same one.
  const runner: Runner<Command> = {
    run: (command, signal) => settled(runs.stream(command, { signal }), signal),
  };
  return {
    source: {
      core: (signal, progress) => ask({ op: 'core' }, signal, progress),
      class: (id, signal) => ask({ op: 'class', id }, signal),
      bytes: (signal) => ask({ op: 'bytes' }, signal),
    },
    ...(!bytes(hello) && hello.runnable && { runner }),
    close() {
      calls.close();
      runs.close();
    },
  };
}
