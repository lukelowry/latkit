import { validateSchema } from '@latkit/model';
import type { CommandDescription, Diagnostic, Parameters, Progress } from '@latkit/model';
import { preparePublication } from './columns.js';
import { deferred, errorOf, failure, integer, interrupt, negotiate, record, text } from './core.js';
import { checkTree, Op, subprotocol } from './frame.js';
import type { Frame } from './frame.js';
import { argumentsOf, definitions, selections, demanded } from './parameters.js';
import { Session } from './session.js';
import type { Sender } from './session.js';
import type { Command, ConnectOptions, Connection, Publish } from './types.js';

/** Register metadata only. Observations start when the host asks for them. */
export async function connectModel<const C extends Record<string, Parameters>>(
  options: ConnectOptions<C>,
): Promise<Connection> {
  options.signal?.throwIfAborted();
  text(options.name);
  const issues = validateSchema(options.schema);
  if (issues.length) throw failure('invalid-input', issues[0].message);
  const url = new URL(options.url);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.hash || url.username || url.password)
    throw failure(
      'invalid-input',
      'Use an HTTP(S) or WS(S) host URL without credentials or a fragment.',
    );
  url.pathname = url.pathname.replace(/\/$/, '') + '/models/' + encodeURIComponent(options.name);
  const ready = deferred<void>();
  const session = new Session(new WebSocket(url.href, subprotocol), options);
  const commands = options.commands as Readonly<Record<string, Command>> | undefined;
  let lastId = 0,
    registered = false,
    executing = false;
  try {
    checkTree(options.schema, session.bounds.maxMetadataBytes);
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
    const catalog = definitions(descriptions, options.schema, session.bounds.maxMetadataBytes);
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
        throw failure('protocol', 'Unexpected producer request.');
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
      const error = errorOf(reason);
      await sender.finish(Op.error, {
        code:
          'code' in error && typeof error.code === 'string' ? error.code.slice(0, 64) : 'internal',
        message:
          error.message.slice(
            0,
            Math.min(2048, Math.floor((session.bounds.maxMetadataBytes - 512) / 6)),
          ) || 'Operation failed.',
      });
    }
    const context = (sender: Sender) => ({
      signal: sender.signal,
      maxBlockBytes: session.bounds.maxMessageBytes - session.bounds.maxMetadataBytes - 64,
    });
    async function observe(frame: Frame, sender: Sender): Promise<void> {
      try {
        if (!options.monitor)
          throw failure('unsupported', 'This producer does not offer monitoring.');
        const fields = selections(frame.metadata.fields, options.schema);
        if (!fields.length) throw failure('invalid-input', 'Monitoring requires field selections.');
        const checkDemand = demanded(fields);
        sender.signal.throwIfAborted();
        const source = options.monitor(fields, context(sender));
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
            await sender.write(
              preparePublication(next.value, sender.id, options.schema, session.bounds),
            );
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
      const publish: Publish = (input) => {
        let task: Promise<void>;
        try {
          sender.signal.throwIfAborted();
          if (!accepting) throw failure('closed', 'The command has already returned.');
          if (pending) throw failure('busy', 'Await publish before publishing again.');
          checkDemand(input);
          task = sender.write(preparePublication(input, sender.id, options.schema, session.bounds));
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
        const command = commands[name],
          description = catalog[name] as CommandDescription;
        const values = argumentsOf(description.parameters, frame.metadata.values ?? {}, frame.body);
        const outputs = selections(frame.metadata.outputs ?? [], options.schema);
        checkDemand = demanded(outputs);
        sender.signal.throwIfAborted();
        const value = await command.run(values, {
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
        checkTree(value ?? null, session.bounds.maxMetadataBytes);
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
        name: options.name,
        schema: options.schema,
        commands: catalog,
        monitoring: Boolean(options.monitor),
        limits: session.bounds,
      }),
      session.lifetime.signal,
      session.bounds.timeoutMs,
    );
    await interrupt(ready.promise, session.lifetime.signal, session.bounds.timeoutMs);
    return { closed: session.closed, close: (reason) => session.close(reason) };
  } catch (error) {
    session.end(errorOf(error));
    throw error;
  }
}

/** At most one latest progress update and a fixed diagnostic ring per execution. */
class Telemetry {
  #progress?: Progress;
  #logs: Diagnostic[] = [];
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
    if (
      !Number.isFinite(value.completed) ||
      value.completed < 0 ||
      (value.total !== undefined &&
        (!Number.isFinite(value.total) || value.total < value.completed))
    )
      throw failure('invalid-input', 'Invalid progress.');
    this.#progress = {
      completed: value.completed,
      ...(value.total === undefined ? {} : { total: value.total }),
      ...(value.message === undefined
        ? {}
        : {
            message: value.message.slice(
              0,
              Math.min(1024, Math.floor((this.session.bounds.maxMetadataBytes - 512) / 6)),
            ),
          }),
    };
    this.schedule();
  }
  log(value: Diagnostic): void {
    if (this.#closed || this.sender.signal.aborted) return;
    if (!['info', 'warning', 'error'].includes(value.severity) || typeof value.message !== 'string')
      throw failure('invalid-input', 'Invalid diagnostic.');
    if (this.#logs.length >= this.session.bounds.maxLogs) {
      this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + 1);
      return;
    }
    this.#logs.push({
      severity: value.severity,
      message: value.message.slice(
        0,
        Math.min(1024, Math.floor((this.session.bounds.maxMetadataBytes - 512) / 6)),
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
        const entries: Diagnostic[] = [];
        let cost = 64;
        while (this.#logs.length) {
          const entry = this.#logs[0];
          const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
          if (cost + size > this.session.bounds.maxMetadataBytes) break;
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
