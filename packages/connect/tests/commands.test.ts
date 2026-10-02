import { expect, it, vi } from 'vitest';
import type { FieldSelection, Input } from '@latkit/model';
import { failure } from '../../model/tests/fixture.js';
import { open, deferred, subscribed } from './fixture.js';
import { LiveModel } from '../../model/tests/live.js';
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
it('cancels a pending reverse content pull and recovers the connection', async () => {
  const model = new LiveModel();
  model.commands.run = async (command) => {
    const reader = (command.values.file as Input).stream.getReader();
    await reader.read();
    return {};
  };
  const connection = await open(model);
  const started = deferred();
  const cancelled = deferred();
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        started.resolve();
      },
      cancel() {
        cancelled.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  try {
    const running = connection.remote.commands!.run(
      { routine: 'solve', values: { file: { stream } } },
      { signal: controller.signal },
    );
    const failed = expect(running).rejects.toMatchObject({ code: 'aborted' });
    await started.promise;
    controller.abort();
    await failed;
    await cancelled.promise;
    expect(stream.locked).toBe(false);
    expect(connection.remote.schema).toBeDefined();
  } finally {
    await connection.close();
  }
});
it('preserves failure targets and issues', async () => {
  const model = new LiveModel();
  model.commands.run = async () => {
    throw Object.assign(failure('invalid-input'), {
      target: { kind: 'parameter', id: 'tmax' },
      issues: [
        { code: 'bounds', message: 'Must be positive.', target: { kind: 'parameter', id: 'tmax' } },
      ],
    });
  };
  const connection = await open(model);
  try {
    await expect(
      connection.remote.commands!.run({ routine: 'solve', values: {} }),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      target: { kind: 'parameter', id: 'tmax' },
      issues: [{ code: 'bounds', message: 'Must be positive.' }],
    });
  } finally {
    await connection.close();
  }
});
it('unwinds partial input setup without leaving locked streams or references', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 6, maxStreams: 2 } });
  const locked = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
  const reader = locked.getReader();
  try {
    for (let i = 0; i < 10; i++) {
      const cancelled = deferred();
      const first = new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancelled.resolve();
          },
        },
        { highWaterMark: 0 },
      );
      await expect(
        connection.remote.commands!.run({
          routine: 'solve',
          values: { first: { stream: first }, second: { stream: locked } },
        }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      await cancelled.promise;
      expect(first.locked).toBe(false);
    }
  } finally {
    reader.releaseLock();
    await connection.close();
  }
});
it('does not acquire content when a command is already aborted', async () => {
  const connection = await open();
  const controller = new AbortController();
  controller.abort();
  try {
    const cancelled = deferred();
    const stream = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      connection.remote.commands!.run(
        { routine: 'solve', values: { file: { stream } } },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    await Promise.resolve();
    expect(stream.locked).toBe(false);
  } finally {
    await connection.close();
  }
});
it('recycles stream reference slots when passive monitors close', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 1, maxStreams: 1 } });
  try {
    for (let i = 0; i < 20; i++) {
      const first = connection.remote.monitor(output)[Symbol.asyncIterator]();
      await subscribed(connection.model);
      await expect(
        connection.remote.monitor(output)[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({ code: 'resource-limit' });
      await first.return?.();
      await vi.waitFor(() => expect(connection.model.subscribers.size).toBe(0));
    }
  } finally {
    await connection.close();
  }
});
