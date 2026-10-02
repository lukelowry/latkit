import { afterEach, expect, expectTypeOf, it } from 'vitest';
import { protocol } from '../src/index.js';
const { decodePublication } = protocol;
import { defaults, deferred } from '../src/core.js';
import { pair, batch, fields, schema, pause, collect } from './fixture.js';
import type { LogEntry, Progress } from '@latkit/model';
import { connectModel } from '../src/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it('registers metadata only, then serves explicitly selected publications', async () => {
  let calls = 0;
  const p = await pair({
    monitor: function* (selection, context) {
      calls++;
      expect(selection).toEqual(fields);
      expect(context.maxBlockBytes).toBeGreaterThan(0);
      yield batch();
    },
  });
  cleanup.push(p.close);
  expect(p.path).toBe('/models/a%20model');
  expect(p.model.name).toBe('a model');
  expect(calls).toBe(0);
  const received = await collect(p.model.monitor(fields));
  expect(calls).toBe(1);
  expect(received).toHaveLength(1);
  expect(received[0][0]).toEqual(batch());
  expect(Object.keys(p.connection).sort()).toEqual(['close', 'closed']);
  expect(p.model).not.toHaveProperty('snapshot');
});
it('forwards a stable connection-independent payload and preserves values after disconnect', async () => {
  const p = await pair({
    monitor: function* () {
      yield batch(32, 9);
    },
  });
  cleanup.push(p.close);
  const received = await collect(p.model.monitor(fields, { format: 'encoded' }));
  await p.close();
  cleanup.pop();
  const result = decodePublication(received[0], schema, defaults);
  expect(result[0]).toEqual(batch(32, 9));
  const column = result[0].columns.value;
  expect(column.kind).toBe('numeric');
  if (column.kind === 'numeric') expect(column.values.buffer).toBe(received[0].bytes.buffer);
});
it('runs typed commands with selected data, coalesced progress, bounded logs and terminal results', async () => {
  const progress: Progress[] = [],
    logs: LogEntry[] = [];
  const p = await pair({
    commands: {
      solve: {
        parameters: { count: { type: 'number', integer: true, min: 1, default: 3 } },
        async run({ count }, ctx) {
          expectTypeOf(count).toEqualTypeOf<number>();
          expect(ctx.outputs).toEqual(fields);
          expect(() => ctx.progress({ completed: 0, domain: [2, 1] })).toThrow('Invalid progress');
          for (let i = 0; i < 100; i++) {
            ctx.progress({ completed: i, total: 100, domain: [0, 10] });
            ctx.log({ severity: 'info', message: '' + i });
          }
          await ctx.publish(batch(count));
          return { count };
        },
      },
    },
  });
  cleanup.push(p.close);
  const received: unknown[] = [];
  const result = await p.model.run(
    'solve',
    {},
    {
      outputs: fields,
      onData: (data) => {
        received.push(data);
      },
      onProgress: (p) => progress.push(p),
      onLog: (log) => logs.push(log),
    },
  );
  expect(result).toEqual({ count: 3 });
  expect(received).toEqual([[batch(3)]]);
  expect(progress.at(-1)).toMatchObject({ completed: 99, domain: [0, 10] });
  expect(logs.filter((l) => l.code !== 'dropped')).toHaveLength(defaults.maxLogs);
  expect(logs.at(-1)?.dropped).toBe(100 - defaults.maxLogs);
});
it('awaits onData before resolving the command result', async () => {
  const gate = deferred<void>(),
    entered = deferred<void>();
  const p = await pair({
    commands: {
      solve: {
        parameters: {},
        async run(_, ctx) {
          await ctx.publish(batch());
          return 42;
        },
      },
    },
  });
  cleanup.push(p.close);
  let done = false;
  const run = p.model
    .run(
      'solve',
      {},
      {
        outputs: fields,
        onData: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    )
    .then((v) => {
      done = true;
      return v;
    });
  await entered.promise;
  await pause();
  expect(done).toBe(false);
  gate.resolve();
  expect(await run).toBe(42);
});
it('validates parameters and transfers bounded file arguments', async () => {
  const p = await pair({
    commands: {
      load: {
        parameters: {
          file: { type: 'file', accept: ['.txt'] },
          mode: { type: 'choice', choices: ['a', 'b'], default: 'a' },
          note: { type: 'text', optional: true },
        },
        async run({ file, mode, note }) {
          return { text: await file.text(), mode, note: note ?? null };
        },
      },
    },
  });
  cleanup.push(p.close);
  await expect(p.model.run('load', { file: new File(['hello'], 'input.txt') })).resolves.toEqual({
    text: 'hello',
    mode: 'a',
    note: null,
  });
  await expect(p.model.run('load', { file: new File(['hello'], 'input.png') })).rejects.toThrow(
    /accepted/,
  );
  await expect(
    p.model.run('load', { file: new File(['hello'], 'input.txt'), mode: 'bad' }),
  ).rejects.toThrow(/choice/);
});
it('cancels a pending monitor pull and finalizes the source', async () => {
  const started = deferred<void>(),
    finalized = deferred<void>();
  const p = await pair({
    monitor: async function* (_, { signal }) {
      try {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
        yield batch();
      } finally {
        finalized.resolve();
      }
    },
  });
  cleanup.push(p.close);
  const abort = new AbortController(),
    stream = p.model.monitor(fields, { signal: abort.signal });
  const pull = stream.next();
  const rejected = expect(pull).rejects.toThrow();
  await started.promise;
  abort.abort();
  await rejected;
  await finalized.promise;
  expect((await stream.next()).done).toBe(true);
});
it('releases finished observation admission on consumption and early return', async () => {
  const p = await pair({
    limits: { maxStreams: 1 },
    monitor: function* () {
      yield batch();
    },
  });
  cleanup.push(p.close);
  for (let i = 0; i < 20; i++) {
    const stream = p.model.monitor(fields);
    await stream.next();
    await stream.return!();
    await pause(2);
  }
  expect(await collect(p.model.monitor(fields))).toHaveLength(1);
});
it('rejects unsolicited command data without poisoning later executions', async () => {
  const p = await pair({
    commands: {
      solve: {
        parameters: {},
        async run(_, ctx) {
          await ctx.publish(batch());
          return null;
        },
      },
      ping: { parameters: {}, run: () => 'pong' },
    },
  });
  cleanup.push(p.close);
  await expect(p.model.run('solve', {})).rejects.toThrow(/requested/);
  await expect(p.model.run('ping', {})).resolves.toBe('pong');
});
it('surfaces command errors, callback failures and cancellation without leaking monitor capacity', async () => {
  const started = deferred<void>(),
    stopped = deferred<void>();
  const p = await pair({
    commands: {
      wait: {
        parameters: {},
        async run(_, { signal }) {
          started.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          stopped.resolve();
          signal.throwIfAborted();
        },
      },
      fail: {
        parameters: {},
        run() {
          throw new Error('solver failed');
        },
      },
    },
    monitor: function* () {
      yield batch();
    },
  });
  cleanup.push(p.close);
  await expect(p.model.run('fail', {})).rejects.toThrow('solver failed');
  const controller = new AbortController();
  const running = p.model.run('wait', {}, { signal: controller.signal });
  const rejection = expect(running).rejects.toThrow();
  await started.promise;
  controller.abort();
  await rejection;
  await stopped.promise;
  expect(await collect(p.model.monitor(fields))).toHaveLength(1);
});
it('rejects already-aborted connection setup', async () => {
  await expect(
    connectModel({ url: 'http://localhost', name: 'test', schema, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});
