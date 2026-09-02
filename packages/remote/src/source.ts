/**
 * A model source and its runner as port services. Only bytes cross: the core, class shards, and
 * the vendor source. A served lineage continues through `reopen`, which replaces what is served in
 * place and supersedes every earlier remote. A run is one stream call: the runner's updates are
 * its items, and cancelling the stream aborts the runner.
 */

import type { Runner, RunUpdate, Source } from '@latkit/model';
import {
  type CallOptions,
  connect,
  type Port,
  protocol,
  serve,
  type Transferred,
  transferred,
} from '@latkit/port';
import { bytes, requests, str } from '@latkit/port/guard';

/** What one side serves: a source and, when it has an engine, a runner. */
export interface Served {
  readonly source: Source;
  readonly runner?: Runner;
}

/** How a served lineage continues: the reopen that turns edited bytes into the next served pair. */
export interface ServeOptions {
  reopen?(bytes: Uint8Array): Promise<Served>;
  onClose?(): void;
}

/**
 * The far side of a served model: its source, its runner when the server can run, and the reopen
 * that supersedes this remote with the next.
 */
export interface RemoteSource {
  readonly source: Source;
  readonly runner?: Runner;
  reopen(bytes: Uint8Array): Promise<RemoteSource>;
  close(): void;
}

type Request =
  | { readonly op: 'hello' }
  | { readonly op: 'core' }
  | { readonly op: 'class'; readonly id: string }
  | { readonly op: 'bytes' }
  | { readonly op: 'reopen'; readonly bytes: Uint8Array };

type Reply = Uint8Array | { readonly runnable: boolean };

const SOURCE = protocol<Request, Reply>(
  'source',
  requests<Request>({ hello: {}, core: {}, class: { id: str }, bytes: {}, reopen: { bytes } }),
);
const RUN = protocol<Uint8Array, RunUpdate>('source:run', bytes);
const SUPERSEDED = 'this remote was superseded by reopen';

function runnable(reply: Reply): boolean {
  return !bytes(reply) && reply.runnable === true;
}

/** Adopt a served pair; a rejected open is reported by the first request that awaits it. */
function adopt(next: Served | Promise<Served>): Promise<Served> {
  const served = Promise.resolve(next);
  void served.catch(() => undefined);
  return served;
}

/** A run that can no longer start: its remote was superseded. */
function superseded(): AsyncIterable<RunUpdate> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(SUPERSEDED)) }),
  };
}

/** Serve one model lineage on `port` until either side closes. Returns the server's own close. */
export function serveSource(
  port: Port,
  initial: Served | Promise<Served>,
  options: ServeOptions = {},
): () => void {
  let served: Promise<Served> | null = adopt(initial);
  let running = false;
  const current = (): Promise<Served> =>
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
      const owned = (data: Uint8Array): Transferred<Reply> =>
        transferred<Reply>(data, [data.buffer as ArrayBuffer]);
      switch (request.op) {
        case 'hello':
          return { runnable: entry.runner !== undefined };
        case 'core':
          return owned(await entry.source.core(signal, progress));
        case 'class':
          return owned(await entry.source.class(request.id, signal));
        case 'bytes':
          return owned(await entry.source.bytes(signal));
        case 'reopen': {
          if (!options.reopen) throw new Error('this source cannot reopen');
          const next = await options.reopen(request.bytes);
          entry.source.close?.();
          served = adopt(next);
          return { runnable: next.runner !== undefined };
        }
      }
    },
    { onClose: close },
  );

  const runs = serve(port, RUN, async function* (command, signal) {
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

/**
 * Connect to the model a `serveSource` peer serves. Closing the remote closes the connection; a
 * remote that `reopen` superseded rejects every later request and owns nothing.
 */
export async function connectSource(port: Port): Promise<RemoteSource> {
  const calls = connect(port, SOURCE);
  const runs = connect(port, RUN);
  let generation = 0;

  const remote = (own: number, canRun: boolean): RemoteSource => {
    const live = (): boolean => own === generation;
    const ask = async (request: Request, options: CallOptions = {}): Promise<Uint8Array> => {
      if (!live()) throw new Error(SUPERSEDED);
      const reply = await calls.call(request, options);
      if (!bytes(reply)) throw new Error('malformed source reply');
      return reply;
    };
    const runner: Runner = {
      run: (command, signal) =>
        live()
          ? runs.stream(command, { signal, transfer: [command.buffer as ArrayBuffer] })
          : superseded(),
    };
    return {
      source: {
        core: (signal, progress) => ask({ op: 'core' }, { signal, progress }),
        class: (id, signal) => ask({ op: 'class', id }, { signal }),
        bytes: (signal) => ask({ op: 'bytes' }, { signal }),
      },
      ...(canRun && { runner }),
      async reopen(next) {
        if (!live()) throw new Error(SUPERSEDED);
        const reply = await calls.call(
          { op: 'reopen', bytes: next },
          { transfer: [next.buffer as ArrayBuffer] },
        );
        return remote(++generation, runnable(reply));
      },
      close() {
        if (!live()) return;
        calls.close();
        runs.close();
      },
    };
  };

  try {
    return remote(0, runnable(await calls.call({ op: 'hello' })));
  } catch (error) {
    calls.close();
    runs.close();
    throw error;
  }
}
