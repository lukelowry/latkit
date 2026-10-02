import { validateSchema } from '@latkit/model';
import type {
  CommandDescription,
  CommandResult,
  FieldSelection,
  InputValue,
  LogEntry,
  Progress,
  Schema,
} from '@latkit/model';
import { decodePublication } from './columns.js';
import {
  deferred,
  errorOf,
  failure,
  integer,
  interrupt,
  negotiate,
  record,
  text,
  validProgress,
} from './core.js';
import { checkTree, Op } from './frame.js';
import type { Frame } from './frame.js';
import { definitions, encodeArguments, selections, demanded } from './parameters.js';
import { Session } from './session.js';
import type { Receiver } from './session.js';
import type {
  AcceptOptions,
  ConnectedModel,
  EncodedMonitorOptions,
  EncodedPublication,
  EncodedRunOptions,
  MonitorOptions,
  Publication,
  RunOptions,
  WebSocketLike,
} from './types.js';

/** Accept one producer socket. Returns after metadata validation and registration, without requesting data. */
export async function acceptModel(
  socket: WebSocketLike,
  options: AcceptOptions = {},
): Promise<ConnectedModel> {
  options.signal?.throwIfAborted();
  const session = new Session(socket, options),
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
    const commands = definitions(m.commands, schema, session.bounds.maxMetadataBytes);
    if (typeof m.monitoring !== 'boolean') throw failure('protocol', 'Invalid monitor capability.');
    session.bounds = negotiate(session.bounds, m.limits);
    const model = new RemoteModel(session, name, schema, commands, m.monitoring);
    session.onControl = () => {
      throw failure('protocol', 'Unexpected producer control message.');
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
  #request = 0;
  #running = false;
  #preparing?: ReturnType<typeof encodeArguments>;
  constructor(
    private readonly session: Session,
    readonly name: string,
    readonly schema: Schema,
    readonly commands: Readonly<Record<string, CommandDescription>>,
    private readonly monitoring: boolean,
  ) {
    this.closed = session.closed;
  }
  close(reason?: { code: string; message: string }): Promise<void> {
    return this.session.close(reason);
  }
  private id(): number {
    return (this.#request = integer(this.#request + 1, 1, 0xffffffff));
  }
  monitor(
    fields: readonly FieldSelection[],
    options: EncodedMonitorOptions,
  ): AsyncIterableIterator<EncodedPublication>;
  monitor(
    fields: readonly FieldSelection[],
    options?: MonitorOptions,
  ): AsyncIterableIterator<Publication>;
  monitor(
    fields: readonly FieldSelection[],
    options: MonitorOptions | EncodedMonitorOptions = {},
  ): AsyncIterableIterator<Publication | EncodedPublication> {
    options.signal?.throwIfAborted();
    if (!this.monitoring) throw failure('unsupported', 'This producer does not offer monitoring.');
    checkTree(fields, this.session.bounds.maxMetadataBytes);
    selections(fields, this.schema);
    if (!fields.length) throw failure('invalid-input', 'Monitoring requires field selections.');
    const checkDemand = demanded(fields);
    const stream = this.session.receiver(this.id());
    const sent = this.session.control(Op.monitor, stream.id, { fields, window: stream.grant });
    void sent.catch((error) => {
      stream.fail(errorOf(error));
      this.session.release(stream);
      options.signal?.removeEventListener('abort', abort);
    });
    const abort = () =>
      stream.cancel(
        errorOf(options.signal?.reason ?? failure('aborted', 'Observation cancelled.')),
      );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let finished = false;
    const cleanup = () => {
      finished = true;
      options.signal?.removeEventListener('abort', abort);
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
            if (next.value.op === Op.error) throw remoteError(next.value.metadata);
            if (next.value.op !== Op.end)
              throw failure('protocol', 'Invalid observation terminal.');
            return { done: true, value: undefined };
          }
          return {
            done: false,
            value: this.publication(next.value.frame, checkDemand, options.format),
          };
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
  run(
    command: string,
    values: Readonly<Record<string, InputValue>>,
    options: EncodedRunOptions,
  ): Promise<CommandResult>;
  run(
    command: string,
    values: Readonly<Record<string, InputValue>>,
    options?: RunOptions,
  ): Promise<CommandResult>;
  async run(
    command: string,
    values: Readonly<Record<string, InputValue>>,
    options: RunOptions | EncodedRunOptions = {},
  ): Promise<CommandResult> {
    options.signal?.throwIfAborted();
    this.session.lifetime.signal.throwIfAborted();
    if (this.#running || this.#preparing)
      throw failure('busy', 'Another command is still running.');
    if (!Object.hasOwn(this.commands, command)) throw failure('invalid-input', 'Unknown command.');
    const outputs = selections(options.outputs ?? [], this.schema);
    checkTree(outputs, this.session.bounds.maxMetadataBytes);
    if (outputs.length && !options.onData)
      throw failure('invalid-input', 'Requested outputs require onData.');
    const checkDemand = demanded(outputs);
    this.#running = true;
    let stream: Receiver | undefined;
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.session.lifetime.signal])
      : this.session.lifetime.signal;
    const abort = () => stream?.cancel(errorOf(signal.reason));
    try {
      const preparing = (this.#preparing = encodeArguments(
        this.commands[command].parameters,
        values,
        this.session.bounds.maxMessageBytes - this.session.bounds.maxMetadataBytes - 64,
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
          if (frame.op === Op.progress) notify(options.onProgress, progressOf(frame.metadata));
          else {
            const entries = frame.metadata.entries,
              dropped = integer(frame.metadata.dropped);
            if (!Array.isArray(entries) || entries.length > this.session.bounds.maxLogs)
              throw failure('protocol', 'Invalid diagnostic batch.');
            const logs = entries.map((entry: unknown) => logOf(entry));
            for (const entry of logs) notify(options.onLog, entry);
            if (dropped)
              notify(options.onLog, {
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
          if (next.value.op === Op.error) throw remoteError(next.value.metadata);
          if (next.value.op !== Op.result) throw failure('protocol', 'Invalid command terminal.');
          checkTree(next.value.metadata.value, this.session.bounds.maxMetadataBytes);
          return next.value.metadata.value as CommandResult;
        }
        if (!outputs.length || !options.onData)
          throw failure('protocol', 'Unrequested execution data.');
        const publication = this.publication(next.value.frame, checkDemand, options.format);
        if (options.format === 'encoded')
          await interrupt(
            Promise.resolve(options.onData(publication as EncodedPublication)),
            signal,
          );
        else await interrupt(Promise.resolve(options.onData(publication as Publication)), signal);
      }
    } catch (error) {
      stream?.cancel(errorOf(error));
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.#running = false;
    }
  }
  private publication(
    frame: Frame,
    checkDemand: ReturnType<typeof demanded>,
    format?: 'decoded' | 'encoded',
  ): Publication | EncodedPublication {
    const encoded = { bytes: frame.payload };
    // Validate once at the trust boundary, even when forwarding encoded payload.
    const batches = decodePublication(encoded, this.schema, this.session.bounds);
    checkDemand(batches);
    return format === 'encoded' ? encoded : batches;
  }
}
function remoteError(metadata: Record<string, unknown>): Error {
  return failure(text(metadata.code, 128), text(metadata.message, 4096));
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
      'Telemetry callbacks must be synchronous; await work in onData.',
    );
  }
}
