import { expect, it } from 'vitest';
import { pair, fields, batch, pause, collect } from './fixture.js';
import { deferred } from '../src/core.js';

it('stops producer pulls at the credit window plus one pending publication while other operations remain usable', async () => {
  let produced = 0;
  const filled = deferred<void>();
  const p = await pair({
    limits: { streamWindowMessages: 4 },
    monitor: function* () {
      for (let n = 0; n < 100; n++) {
        produced++;
        if (produced === 5) filled.resolve();
        yield batch();
      }
    },
    commands: { ping: { parameters: {}, run: () => 'pong' } },
  });
  const stream = p.model.monitor(fields);
  try {
    await filled.promise;
    await pause(30);
    expect(produced).toBe(5);
    await expect(p.model.run('ping', {})).resolves.toBe('pong');
    expect((await stream.next()).done).toBe(false);
    await pause(10);
    expect(produced).toBe(5);
    await stream.next();
    await pause(20);
    expect(produced).toBe(6);
  } finally {
    await stream.return!();
    await p.close();
  }
});
it('rejects concurrent publishes and sends only selected fields', async () => {
  const p = await pair({
    commands: {
      bad: {
        parameters: {},
        async run(_, ctx) {
          const first = ctx.publish(batch());
          await expect(ctx.publish(batch())).rejects.toThrow(/Await publish/);
          await first;
        },
      },
      extra: {
        parameters: {},
        async run(_, ctx) {
          await ctx.publish(batch());
        },
      },
    },
  });
  try {
    await expect(p.model.run('bad', {}, { outputs: fields, onData: () => {} })).rejects.toThrow(
      /Await publish/,
    );
    await expect(
      p.model.run(
        'extra',
        {},
        { outputs: [{ from: 'Node', select: ['output'] }], onData: () => {} },
      ),
    ).rejects.toThrow(/unrequested/);
  } finally {
    await p.close();
  }
});
it('aborts an in-progress data callback promptly and retains the producer slot until cooperative exit', async () => {
  const entered = deferred<void>(),
    blocked = deferred<void>(),
    finished = deferred<void>();
  const p = await pair({
    commands: {
      work: {
        parameters: {},
        async run(_, ctx) {
          await ctx.publish(batch());
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          finished.resolve();
          ctx.signal.throwIfAborted();
        },
      },
    },
    monitor: function* () {
      yield batch();
    },
  });
  const controller = new AbortController();
  try {
    const task = p.model.run(
      'work',
      {},
      {
        signal: controller.signal,
        outputs: fields,
        onData: async () => {
          entered.resolve();
          await blocked.promise;
        },
      },
    );
    const rejection = expect(task).rejects.toThrow();
    await entered.promise;
    controller.abort();
    await rejection;
    await finished.promise;
    expect(await collect(p.model.monitor(fields))).toHaveLength(1);
  } finally {
    blocked.resolve();
    await p.close();
  }
});
it('keeps repeated empty and failed streams bounded', async () => {
  let calls = 0;
  const p = await pair({
    limits: { maxStreams: 1 },
    monitor: () => {
      if (calls++ % 2) throw new Error('source failed');
      return [];
    },
  });
  try {
    for (let i = 0; i < 40; i++) {
      const task = collect(p.model.monitor(fields));
      if (i % 2) await expect(task).rejects.toThrow('source failed');
      else expect(await task).toEqual([]);
    }
  } finally {
    await p.close();
  }
});
it('propagates abrupt socket failure to a pending consumer', async () => {
  const started = deferred<void>();
  const p = await pair({
    monitor: async function* (_, { signal }) {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      yield batch();
    },
  });
  try {
    const next = p.model.monitor(fields).next(),
      rejected = expect(next).rejects.toThrow();
    await started.promise;
    p.socket.terminate();
    await rejected;
    await expect(p.connection.closed).rejects.toThrow();
  } finally {
    await p.close();
  }
});

it('returns bounded errors for oversized results and releases unsent command reservations', async () => {
  const p = await pair({
    limits: { maxMetadataBytes: 1024, maxStreams: 1 },
    commands: {
      echo: {
        parameters: { text: { type: 'text' } },
        run: ({ text }) => {
          if (typeof text !== 'string') throw new Error('Expected text');
          return text;
        },
      },
      large: { parameters: {}, run: () => 'x'.repeat(1020) },
      ping: { parameters: {}, run: () => 'pong' },
    },
  });
  try {
    await expect(p.model.run('large', {})).rejects.toThrow(/large|budget/);
    for (let i = 0; i < 5; i++)
      await expect(p.model.run('echo', { text: 'x'.repeat(4096) })).rejects.toThrow(/large|budget/);
    await expect(p.model.run('ping', {})).resolves.toBe('pong');
  } finally {
    await p.close();
  }
});
it('bounds worst-case escaped diagnostics under minimum metadata limits', async () => {
  const p = await pair({
    limits: { maxMetadataBytes: 1024 },
    commands: {
      log: {
        parameters: {},
        run(_, ctx) {
          for (let i = 0; i < 100; i++)
            ctx.log({ severity: 'warning', message: '\0'.repeat(4096), code: '\0'.repeat(128) });
          return true;
        },
      },
    },
  });
  let logs = 0,
    dropped = 0;
  try {
    await expect(
      p.model.run(
        'log',
        {},
        {
          onLog: (entry) => {
            logs++;
            dropped += entry.dropped ?? 0;
          },
        },
      ),
    ).resolves.toBe(true);
    expect(logs).toBe(33);
    expect(dropped).toBe(68);
  } finally {
    await p.close();
  }
});

it('bounds cancellation and close when a handler ignores its signal', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const p = await pair({
    limits: { timeoutMs: 100 },
    commands: {
      stuck: {
        parameters: {},
        async run() {
          entered.resolve();
          await release.promise;
        },
      },
    },
  });
  const stop = new AbortController();
  try {
    const run = p.model.run('stuck', {}, { signal: stop.signal });
    const cancelled = expect(run).rejects.toThrow();
    const closed = expect(p.model.closed).rejects.toThrow(/cancellation/);
    await entered.promise;
    stop.abort();
    await cancelled;
    await closed;
  } finally {
    release.resolve();
    await p.close();
  }
});
it('fails asynchronous telemetry callbacks explicitly without unhandled rejections', async () => {
  const p = await pair({
    commands: {
      status: {
        parameters: {},
        run(_, ctx) {
          ctx.progress({ completed: 1 });
          return true;
        },
      },
    },
  });
  try {
    await expect(
      p.model.run(
        'status',
        {},
        {
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Exercise a JavaScript caller violating the synchronous callback contract.
          onProgress: async () => {
            throw new Error('callback failed');
          },
        },
      ),
    ).rejects.toThrow(/synchronous/);
  } finally {
    await p.close();
  }
});

it('does not accumulate native File reads when callers abort preparation', async () => {
  const started = deferred<void>(),
    release = deferred<ArrayBuffer>();
  class SlowFile extends File {
    override arrayBuffer() {
      started.resolve();
      return release.promise;
    }
  }
  const p = await pair({
    commands: { load: { parameters: { file: { type: 'file' } }, run: () => true } },
  });
  const stop = new AbortController(),
    file = new SlowFile(['x'], 'x');
  try {
    const run = p.model.run('load', { file }, { signal: stop.signal });
    const rejected = expect(run).rejects.toThrow();
    await started.promise;
    stop.abort();
    await rejected;
    await expect(p.model.run('load', { file })).rejects.toThrow(/running/);
    release.resolve(new ArrayBuffer(1));
    await pause();
    await expect(p.model.run('load', { file: new File(['x'], 'x') })).resolves.toBe(true);
  } finally {
    release.resolve(new ArrayBuffer(1));
    await p.close();
  }
});
