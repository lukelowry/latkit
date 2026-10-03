import { failure, validateSchema } from '@latkit/model';
import type {
  Arguments,
  CommandContext,
  CommandDescription,
  CommandResult,
  FieldSelection,
  InputValue,
  LogEntry,
  MonitorContext,
  Parameters,
  Progress,
  Publication,
  Schema,
} from '@latkit/model';
import { decodePublication } from './columns.js';
import {
  deferred,
  errorOf,
  integer,
  interrupt,
  negotiate,
  record,
  text,
  validProgress,
  fromPeer,
  peerFailure,
} from './core.js';
import { checkTree, Op, subprotocols } from './frame.js';
import type { Frame } from './frame.js';
import { definitions, encodeArguments, selections, demanded } from './parameters.js';
import { Session } from './session.js';
import { dial } from './socket.js';
import type { Receiver } from './session.js';
import type { AcceptOptions, ConnectedModel } from './types.js';

/** Accept the model served at exactly `url`, or on a `socket` a server accepted. Resolves after
 *  metadata validation and registration, without requesting data. */
export async function acceptModel(options: AcceptOptions): Promise<ConnectedModel> {
  options.signal?.throwIfAborted();
  const socket = options.socket ?? dial(options.url, subprotocols.accept);
  const session = new Session(socket, {
      subprotocol: options.socket ? subprotocols.connect : subprotocols.accept,
      limits: options.limits,
      signal: options.signal,
    }),
    registered = deferred<RemoteModel>();
  let seen = false;
  session.onControl = (frame) => {
    if (seen || frame.op !== Op.register || frame.id !== 0)
      throw failure('protocol', 'Expected one registration.');
    seen = true;
    const m = frame.metadata,
      name = text(m.name);
    const issues = validateSchema(m.schema);
    if (issues.length) throw failure('protocol', issues[0].message);
    const schema = m.schema as Schema;
    const commands = definitions(m.commands, schema, session.bounds.metadataBytes);
    if (typeof m.monitoring !== 'boolean') throw failure('protocol', 'Invalid monitor capability.');
    session.bounds = negotiate(session.bounds, m.limits);
    const model = new RemoteModel(session, name, schema, commands, m.monitoring);
    session.onControl = () => {
      throw failure('protocol', 'Unexpected control message from the model.');
    };
    session.track(
      session
        .control(Op.registered, 0, { limits: session.bounds })
        .then(() => registered.resolve(model)),
    );
  };
  try {
    await interrupt(
      session.socket.ready.promise,
      session.lifetime.signal,
      session.bounds.timeoutMs,
    );
    return await interrupt(registered.promise, session.lifetime.signal, session.bounds.timeoutMs);
  } catch (error) {
    session.end(errorOf(error));
    throw error;
  }
}

class RemoteModel implements ConnectedModel {
  readonly closed: Promise<void>;
  declare readonly monitor?: ConnectedModel['monitor'];
  readonly commands: ConnectedModel['commands'];
  #request = 0;
  #running = false;
  #preparing?: ReturnType<typeof encodeArguments>;
  constructor(
    private readonly session: Session,
    readonly name: string,
    readonly schema: Schema,
    descriptions: Readonly<Record<string, CommandDescription>>,
    monitoring: boolean,
  ) {
    this.closed = session.closed;
    if (monitoring) this.monitor = (fields, context) => this.observe(fields, context);
    this.commands = Object.freeze(
      Object.fromEntries(
        Object.entries(descriptions).map(([name, description]) => [
          name,
          Object.freeze({
            ...description,
            run: (
              values: Arguments<Parameters> | Readonly<Record<string, InputValue>>,
              context?: Partial<CommandContext>,
            ) => this.execute(name, description, values, context),
          }),
        ]),
      ),
    );
  }
  close(reason?: { code: string; message: string }): Promise<void> {
    return this.session.close(reason);
  }
  private id(): number {
    return (this.#request = integer(this.#request + 1, 1, 0xffffffff));
  }
  private observe(
    fields: readonly FieldSelection[],
    context: Partial<MonitorContext> = {},
  ): AsyncIterableIterator<Publication> {
    context.signal?.throwIfAborted();
    checkTree(fields, this.session.bounds.metadataBytes);
    selections(fields, this.schema);
    // An empty selection reads nothing.
    if (!fields.length) return (async function* () {})();
    const checkDemand = demanded(fields);
    const stream = this.session.receiver(this.id());
    const sent = this.session.control(Op.monitor, stream.id, { fields, window: stream.grant });
    void sent.catch((error) => {
      stream.fail(errorOf(error));
      this.session.release(stream);
      context.signal?.removeEventListener('abort', abort);
    });
    const abort = () =>
      stream.cancel(
        errorOf(context.signal?.reason ?? failure('aborted', 'Observation cancelled.')),
      );
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    let finished = false;
    const cleanup = () => {
      finished = true;
      context.signal?.removeEventListener('abort', abort);
    };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (finished) return { done: true, value: undefined };
        try {
          await interrupt(sent, stream.signal);
          const next = await stream.next();
          if (next.done) {
            cleanup();
            if (next.value.op === Op.error) throw peerFailure(next.value.metadata);
            if (next.value.op !== Op.end)
              throw failure('protocol', 'Invalid observation terminal.');
            return { done: true, value: undefined };
          }
          return { done: false, value: this.publication(next.value.frame, checkDemand) };
        } catch (error) {
          cleanup();
          stream.cancel(errorOf(error));
          throw error;
        }
      },
      return: () => {
        cleanup();
        stream.cancel();
        return Promise.resolve({ done: true, value: undefined });
      },
      throw: (error: unknown) => {
        cleanup();
        stream.cancel(errorOf(error));
        return Promise.reject(errorOf(error));
      },
    };
  }
  private async execute(
    command: string,
    description: CommandDescription,
    values: Arguments<Parameters> | Readonly<Record<string, InputValue>>,
    context: Partial<CommandContext> = {},
  ): Promise<CommandResult> {
    context.signal?.throwIfAborted();
    this.session.lifetime.signal.throwIfAborted();
    if (this.#running || this.#preparing)
      throw failure('busy', 'Another command is still running.');
    const outputs = selections(context.outputs ?? [], this.schema);
    checkTree(outputs, this.session.bounds.metadataBytes);
    const publish = context.publish;
    if (outputs.length && !publish)
      throw failure('invalid-input', 'Requested outputs require publish.');
    const checkDemand = demanded(outputs);
    this.#running = true;
    let stream: Receiver | undefined;
    const signal = context.signal
      ? AbortSignal.any([context.signal, this.session.lifetime.signal])
      : this.session.lifetime.signal;
    const abort = () => stream?.cancel(errorOf(signal.reason));
    try {
      const preparing = (this.#preparing = encodeArguments(
        description.parameters,
        values,
        this.session.bounds.messageBytes - this.session.bounds.metadataBytes - 64,
        signal,
      ));
      // An aborted File read may still be running natively. Keep admission until it settles.
      const settled = preparing.then(
        () => {
          this.#preparing = undefined;
        },
        () => {
          this.#preparing = undefined;
        },
      );
      this.session.track(settled);
      const args = await interrupt(preparing, signal);
      stream = this.session.receiver(this.id());
      stream.onTelemetry = (frame) => {
        try {
          if (frame.op === Op.progress) notify(context.progress, progressOf(frame.metadata));
          else {
            const entries = frame.metadata.entries,
              dropped = integer(frame.metadata.dropped);
            if (!Array.isArray(entries) || entries.length > this.session.bounds.logs)
              throw failure('protocol', 'Invalid diagnostic batch.');
            const logs = entries.map((entry: unknown) => logOf(entry));
            for (const entry of logs) notify(context.log, entry);
            if (dropped)
              notify(context.log, {
                severity: 'warning',
                code: 'dropped',
                message: 'Diagnostic messages were dropped.',
                dropped,
              });
          }
        } catch (error) {
          stream?.cancel(errorOf(error));
        }
      };
      const sending = this.session.control(
        Op.run,
        stream.id,
        { command, values: args.values, outputs, window: stream.grant },
        args.chunks,
      );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const requested = stream;
      void sending.catch((error) => {
        requested.fail(errorOf(error));
        this.session.release(requested);
      });
      await interrupt(sending, signal);
      for (;;) {
        const next = await stream.next();
        if (next.done) {
          if (next.value.op === Op.error) throw peerFailure(next.value.metadata);
          if (next.value.op !== Op.result) throw failure('protocol', 'Invalid command terminal.');
          checkTree(next.value.metadata.value, this.session.bounds.metadataBytes);
          return next.value.metadata.value as CommandResult;
        }
        if (!outputs.length || !publish) throw failure('protocol', 'Unrequested execution data.');
        await interrupt(publish(this.publication(next.value.frame, checkDemand)), signal);
      }
    } catch (error) {
      stream?.cancel(errorOf(error));
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.#running = false;
    }
  }
  private publication(frame: Frame, checkDemand: ReturnType<typeof demanded>): Publication {
    // Validated once at the trust boundary; served onward, it goes as it arrived.
    const batches = fromPeer(() =>
      decodePublication({ bytes: frame.payload }, this.schema, this.session.bounds),
    );
    checkDemand(batches);
    return batches;
  }
}
function progressOf(m: Record<string, unknown>): Progress {
  if (!validProgress(m)) throw failure('protocol', 'Invalid progress.');
  const domain = m.domain as Progress['domain'];
  return {
    completed: m.completed as number,
    ...(m.total === undefined ? {} : { total: m.total as number }),
    ...(m.message === undefined ? {} : { message: boundedText(m.message, 1024) }),
    ...(domain === undefined ? {} : { domain: [domain[0], domain[1]] }),
  };
}
function logOf(value: unknown): LogEntry {
  const m = record(value);
  if (!['info', 'warning', 'error'].includes(String(m.severity)))
    throw failure('protocol', 'Invalid diagnostic severity.');
  return {
    severity: m.severity as LogEntry['severity'],
    message: boundedText(m.message, 1024),
    ...(m.code === undefined ? {} : { code: boundedText(m.code, 128) }),
  };
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw failure('protocol', 'Invalid text.');
  return value;
}

function notify<T>(callback: ((value: T) => void) | undefined, value: T): void {
  const result: unknown = callback?.(value);
  if (
    result &&
    typeof result === 'object' &&
    'then' in result &&
    typeof result.then === 'function'
  ) {
    void Promise.resolve(result).catch(() => {});
    throw failure(
      'invalid-input',
      'Telemetry callbacks must be synchronous; await work in publish.',
    );
  }
}
