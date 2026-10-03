import { failure, validateSchema } from '@latkit/model';
import type {
  Command,
  CommandContext,
  CommandDescription,
  LogEntry,
  Model,
  Parameters,
  Progress,
} from '@latkit/model';
import { publicationPlans } from './columns.js';
import {
  deferred,
  errorOf,
  integer,
  interrupt,
  negotiate,
  reasonOf,
  record,
  text,
  validProgress,
  limits,
} from './core.js';
import { checkTree, Op, subprotocols } from './frame.js';
import type { Frame } from './frame.js';
import { argumentsOf, definitions, selections, demanded } from './parameters.js';
import { Session } from './session.js';
import { dial } from './socket.js';
import type { Sender } from './session.js';
import type { ConnectOptions, Connection } from './types.js';

/**
 * Serve `model` to whoever accepts it: dial exactly `url`, or answer on a `socket` a server accepted.
 * Registers metadata only; reads and runs start when the other side asks for them. A model that is
 * itself a connection, such as one `acceptModel` returned, is served until it closes, and its
 * reason closes this connection too.
 */
export async function connectModel<const C extends Record<string, Parameters>>(
  model: Model<C>,
  options: ConnectOptions,
): Promise<Connection> {
  options.signal?.throwIfAborted();
  // Everything the model describes is checked before any socket opens.
  text(model.name);
  const issues = validateSchema(model.schema);
  if (issues.length) throw failure('invalid-input', issues[0].message);
  const bounds = limits(options.limits);
  checkTree(model.schema, bounds.metadataBytes);
  const commands = model.commands as Readonly<Record<string, Command>> | undefined;
  const descriptions = Object.fromEntries(
    Object.entries(commands ?? {}).map(([name, command]) => {
      if (typeof command.run !== 'function')
        throw failure('invalid-input', 'A command needs a run function.');
      const { parameters, label, description } = command;
      return [
        name,
        {
          parameters,
          ...(label === undefined ? {} : { label }),
          ...(description === undefined ? {} : { description }),
        },
      ];
    }),
  );
  const catalog = definitions(descriptions, model.schema, bounds.metadataBytes);
  const socket = options.socket ?? dial(options.url, subprotocols.connect);
  const ready = deferred<void>();
  const session = new Session(socket, {
    subprotocol: options.socket ? subprotocols.accept : subprotocols.connect,
    limits: bounds,
    signal: options.signal,
  });
  let lastId = 0,
    registered = false,
    executing = false;
  try {
    session.onControl = (frame) => {
      if (frame.op === Op.registered) {
        if (registered || frame.id)
          throw failure('protocol', 'Unexpected registration acknowledgement.');
        session.bounds = negotiate(session.bounds, frame.metadata.limits);
        registered = true;
        ready.resolve();
        return;
      }
      if (!registered || (frame.op !== Op.monitor && frame.op !== Op.run))
        throw failure('protocol', 'Unexpected request to the model.');
      const id = integer(frame.id, lastId + 1, 0xffffffff);
      lastId = id;
      const grant = record(frame.metadata.window);
      const sender = session.sender(id, grant.bytes, grant.messages);
      if (frame.op === Op.monitor) {
        session.track(observe(frame, sender));
        return;
      }
      if (executing) {
        session.track(
          sender.finish(Op.error, { code: 'busy', message: 'Another command is still running.' }),
        );
        return;
      }
      executing = true;
      session.track(
        execute(frame, sender).finally(() => {
          executing = false;
        }),
      );
    };
    async function report(sender: Sender, reason: unknown): Promise<void> {
      if (session.lifetime.signal.aborted) return;
      await sender.finish(
        Op.error,
        reasonOf(reason, Math.min(2048, Math.floor((session.bounds.metadataBytes - 512) / 6))),
      );
    }
    const context = (sender: Sender) => ({
      signal: sender.signal,
      maxBlockBytes: session.bounds.messageBytes - session.bounds.metadataBytes - 64,
    });
    async function observe(frame: Frame, sender: Sender): Promise<void> {
      try {
        if (!model.monitor) throw failure('unsupported', 'This model does not offer monitoring.');
        const fields = selections(frame.metadata.fields, model.schema);
        const checkDemand = demanded(fields);
        sender.signal.throwIfAborted();
        // An empty selection reads nothing.
        const source = fields.length ? model.monitor(fields, context(sender)) : [];
        const iterator =
          Symbol.asyncIterator in source
            ? source[Symbol.asyncIterator]()
            : source[Symbol.iterator]();
        try {
          for (;;) {
            sender.signal.throwIfAborted();
            const next = await interrupt(Promise.resolve(iterator.next()), sender.signal);
            if (next.done) break;
            checkDemand(next.value);
            for (const plan of publicationPlans(
              next.value,
              sender.id,
              model.schema,
              session.bounds,
            ))
              await sender.write(plan);
          }
        } finally {
          if (iterator.return)
            await interrupt(
              Promise.resolve(iterator.return()),
              session.lifetime.signal,
              session.bounds.timeoutMs,
            );
        }
        await sender.finish(Op.end);
      } catch (error) {
        await report(sender, sender.signal.aborted ? sender.signal.reason : error);
      }
    }
    async function execute(frame: Frame, sender: Sender): Promise<void> {
      const telemetry = new Telemetry(session, sender);
      let checkDemand = demanded([]);
      let accepting = true,
        pending: Promise<void> | undefined,
        publishFailure: Error | undefined;
      const publish: CommandContext['publish'] = (input) => {
        let task: Promise<void>;
        try {
          sender.signal.throwIfAborted();
          if (!accepting) throw failure('closed', 'The command has already returned.');
          if (pending) throw failure('busy', 'Await publish before publishing again.');
          checkDemand(input);
          const plans = publicationPlans(input, sender.id, model.schema, session.bounds);
          task = (async () => {
            for (const plan of plans) await sender.write(plan);
          })();
          pending = task;
        } catch (error) {
          task = Promise.reject(errorOf(error));
        }
        void task.then(
          () => {
            if (pending === task) pending = undefined;
          },
          (error) => {
            publishFailure = errorOf(error);
            if (pending === task) pending = undefined;
          },
        );
        return task;
      };
      try {
        const name = text(frame.metadata.command);
        if (!commands || !Object.hasOwn(commands, name))
          throw failure('invalid-input', 'Unknown command.');
        const description = catalog[name] as CommandDescription;
        const values = argumentsOf(description.parameters, frame.metadata.values ?? {}, frame.body);
        const outputs = selections(frame.metadata.outputs ?? [], model.schema);
        checkDemand = demanded(outputs);
        sender.signal.throwIfAborted();
        const value = await commands[name].run(values, {
          ...context(sender),
          outputs,
          publish,
          progress: (value) => telemetry.progress(value),
          log: (value) => telemetry.log(value),
        });
        accepting = false;
        telemetry.seal();
        if (pending) await pending;
        if (publishFailure) throw publishFailure;
        sender.signal.throwIfAborted();
        await telemetry.flush();
        checkTree(value ?? null, session.bounds.metadataBytes);
        await sender.finish(Op.result, { value: value ?? null });
      } catch (error) {
        accepting = false;
        telemetry.seal();
        sender.cancel(errorOf(error));
        if (pending) await pending.catch(() => {});
        await telemetry.flush().catch(() => {});
        await report(sender, error);
      } finally {
        accepting = false;
        telemetry.close();
      }
    }
    await interrupt(
      session.socket.ready.promise,
      session.lifetime.signal,
      session.bounds.timeoutMs,
    );
    await interrupt(
      session.control(Op.register, 0, {
        name: model.name,
        schema: model.schema,
        commands: catalog,
        monitoring: Boolean(model.monitor),
        limits: session.bounds,
      }),
      session.lifetime.signal,
      session.bounds.timeoutMs,
    );
    await interrupt(ready.promise, session.lifetime.signal, session.bounds.timeoutMs);
    const source = (model as Partial<Connection>).closed;
    if (source instanceof Promise) {
      // Held weakly: a connection that ended first is not kept until the model closes.
      const served = new WeakRef(session);
      const end = (error?: unknown) =>
        void served
          .deref()
          ?.close(
            error === undefined
              ? { code: 'closed', message: `${model.name} closed.` }
              : reasonOf(error),
          );
      void source.then(() => end(), end);
    }
    return { closed: session.closed, close: (reason) => session.close(reason) };
  } catch (error) {
    session.end(errorOf(error));
    throw error;
  }
}

/** At most one latest progress update and a fixed diagnostic ring per execution. */
class Telemetry {
  #progress?: Progress;
  #logs: LogEntry[] = [];
  #dropped = 0;
  #timer?: ReturnType<typeof setTimeout>;
  #sending?: Promise<void>;
  #closed = false;
  constructor(
    private readonly session: Session,
    private readonly sender: Sender,
  ) {}
  progress(value: Progress): void {
    if (this.#closed || this.sender.signal.aborted) return;
    if (!validProgress(value as unknown as Record<string, unknown>))
      throw failure('invalid-input', 'Invalid progress.');
    this.#progress = {
      completed: value.completed,
      ...(value.total === undefined ? {} : { total: value.total }),
      ...(value.domain === undefined ? {} : { domain: [value.domain[0], value.domain[1]] }),
      ...(value.message === undefined
        ? {}
        : {
            message: value.message.slice(
              0,
              Math.min(1024, Math.floor((this.session.bounds.metadataBytes - 512) / 6)),
            ),
          }),
    };
    this.schedule();
  }
  log(value: LogEntry): void {
    if (this.#closed || this.sender.signal.aborted) return;
    if (!['info', 'warning', 'error'].includes(value.severity) || typeof value.message !== 'string')
      throw failure('invalid-input', 'Invalid diagnostic.');
    // Losses reported upstream stay a count, so a model served onward reports them as its own.
    if (value.dropped) {
      this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + value.dropped);
      this.schedule();
      return;
    }
    if (this.#logs.length >= this.session.bounds.logs) {
      this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + 1);
      return;
    }
    this.#logs.push({
      severity: value.severity,
      message: value.message.slice(
        0,
        Math.min(1024, Math.floor((this.session.bounds.metadataBytes - 512) / 6)),
      ),
      ...(value.code === undefined ? {} : { code: value.code.slice(0, 64) }),
    });
    this.schedule();
  }
  private schedule(): void {
    if (this.#timer || this.#sending) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush().catch((error) => this.session.end(errorOf(error)));
    }, 16);
  }
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#sending) return this.#sending;
    const drain = async () => {
      while (
        !this.session.lifetime.signal.aborted &&
        (this.#progress || this.#logs.length || this.#dropped)
      ) {
        const progress = this.#progress;
        this.#progress = undefined;
        if (progress) await this.session.control(Op.progress, this.sender.id, { ...progress });
        // Split diagnostics by encoded metadata size, retaining at most one ring plus one message.
        const entries: LogEntry[] = [];
        let cost = 64;
        while (this.#logs.length) {
          const entry = this.#logs[0];
          const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
          if (cost + size > this.session.bounds.metadataBytes) break;
          cost += size;
          entries.push(this.#logs.shift()!);
        }
        const dropped = this.#dropped;
        this.#dropped = 0;
        if (entries.length || dropped)
          await this.session.control(Op.log, this.sender.id, { entries, dropped });
      }
    };
    this.#sending = drain().finally(() => {
      this.#sending = undefined;
    });
    return this.#sending;
  }
  seal(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
  }
  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#logs = [];
    this.#progress = undefined;
  }
}
