/**
 * A model served across a port: its bytes, the core and each class shard as they are asked for,
 * and its engine's runs as streams. `connectModel` opens it on the far side, classes still lazy,
 * running on the served engine; only bytes and run updates cross.
 */

import { openModel, type Model, type RunUpdate, type Source } from '@latkit/model';

import { connect, serve, transferred, type Remote } from './channel.js';
import { check, type Check } from './check.js';
import type { Port } from './port.js';
import { protocol, type Progress } from './protocol.js';

type Request =
  | { readonly op: 'open' }
  | { readonly op: 'class'; readonly id: string }
  | { readonly op: 'bytes' };

/** What an open replies: the core, and whether the model can run. */
interface Opened {
  readonly core: Uint8Array;
  readonly runnable: boolean;
}

const MODEL = protocol<Request, Uint8Array | Opened>(
  'model',
  check.requests<Request>({ open: {}, class: { id: check.string }, bytes: {} }),
);
const RUN = 'model:run';

const opened: Check<Opened> = check.object<Opened>({
  core: check.bytes,
  runnable: check.boolean,
});

/**
 * Serve one model on `port` until either side closes; a run's command is bytes. Returns the
 * server's own close.
 *
 * @remarks
 * A model still opening is served once it opens, so no early request is lost. One run goes at a
 * time; cancelling its stream aborts it.
 *
 * @param options - `onClose` fires once the service has ended.
 */
export function serveModel(
  port: Port,
  model: Model | Promise<Model>,
  options?: { onClose?(): void },
): () => void;
/**
 * Serve one model whose engine takes a structured command. The peer is untrusted, so `command`
 * checks what it sends a run.
 */
export function serveModel<Command>(
  port: Port,
  model: Model<Command> | Promise<Model<Command>>,
  options: { readonly command: Check<Command>; onClose?(): void },
): () => void;
export function serveModel<Command>(
  port: Port,
  model: Model<Command> | Promise<Model<Command>>,
  options: { readonly command?: Check<Command>; onClose?(): void } = {},
): () => void {
  let served: Promise<Source<Command>> | null = Promise.resolve(model).then((opened) =>
    opened.source(),
  );
  // A rejected open is reported by the first request that awaits it.
  void served.catch(() => undefined);
  let running = false;
  const current = (): Promise<Source<Command>> =>
    served ?? Promise.reject(new Error('the served model was closed'));

  function close(): void {
    const closing = served;
    if (!closing) return;
    served = null;
    void closing.then(
      (source) => source.close?.(),
      () => undefined,
    );
    options.onClose?.();
  }

  const calls = serve(
    port,
    MODEL,
    async (request, signal, progress) => {
      const source = await current();
      const owned = (data: Uint8Array) => transferred(data, [data.buffer as ArrayBuffer]);
      switch (request.op) {
        case 'open': {
          const core = await source.core(signal, progress);
          return transferred<Opened>({ core, runnable: source.run !== undefined }, [
            core.buffer as ArrayBuffer,
          ]);
        }
        case 'class':
          return owned(await source.class(request.id, signal));
        case 'bytes':
          return owned(await source.bytes(signal));
      }
    },
    { onClose: close },
  );

  const run = protocol<Command, RunUpdate>(RUN, options.command ?? (check.bytes as Check<Command>));
  const runs = serve(port, run, async function* (command, signal) {
    const source = await current();
    if (!source.run) throw new Error('this model cannot run');
    if (running) throw new Error('a run is already in progress');
    running = true;
    try {
      yield* source.run(command, signal);
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
 * Open the model a `serveModel` peer serves: its classes load across the port as they are asked
 * for, and it runs on the peer's engine when the peer has one. Closing it closes the connection.
 *
 * @throws Error when the peer cannot open the model, or serves an inconsistent one.
 */
export async function connectModel<Command = Uint8Array>(
  port: Port,
  options: { readonly signal?: AbortSignal; readonly progress?: Progress } = {},
): Promise<Remote<Model<Command>>> {
  const calls = connect(port, MODEL);
  const runs = connect(port, protocol<Command, RunUpdate>(RUN));
  const close = (): void => {
    calls.close();
    runs.close();
  };
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
    const { core, runnable } = reply;
    // The caller keeps every command it passes in: a command is small enough to copy, and a run
    // may start again from the same one.
    const model = await openModel<Command>({
      core: () => Promise.resolve(core),
      class: (id, signal) => ask({ op: 'class', id }, signal),
      bytes: (signal) => ask({ op: 'bytes' }, signal),
      ...(runnable && {
        run: (command: Command, signal?: AbortSignal) => runs.stream(command, { signal }),
      }),
    });
    return Object.assign(model, { close });
  } catch (error) {
    close();
    throw error;
  }
}
