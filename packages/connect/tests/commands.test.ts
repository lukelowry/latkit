import { expect, it } from 'vitest';
import type { FieldSelection, Input } from '@latkit/model';
import { FixtureModel, failure } from '../../model/tests/fixture.js';
import { open, deferred, reached } from './fixture.js';
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
it('cancels a pending reverse content pull and recovers the connection', async () => {
  const model = new FixtureModel();
  model.run = async (command) => {
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
    const running = connection.remote.run(
      { routine: 'solve', values: { file: { stream } } },
      { signal: controller.signal },
    );
    const failed = expect(running).rejects.toMatchObject({ code: 'aborted' });
    await started.promise;
    controller.abort();
    await failed;
    await cancelled.promise;
    expect(stream.locked).toBe(false);
    expect(await connection.remote.describe()).toBeDefined();
  } finally {
    await connection.close();
  }
});
it('preserves failure targets and issues', async () => {
  const model = new FixtureModel();
  model.run = async () => {
    throw Object.assign(failure('invalid-input'), {
      target: { kind: 'parameter', id: 'tmax' },
      issues: [
        { code: 'bounds', message: 'Must be positive.', target: { kind: 'parameter', id: 'tmax' } },
      ],
    });
  };
  const connection = await open(model);
  try {
    await expect(connection.remote.run({ routine: 'solve', values: {} })).rejects.toMatchObject({
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
        connection.remote.run({
          routine: 'solve',
          values: { first: { stream: first }, second: { stream: locked } },
        }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      await cancelled.promise;
      expect(first.locked).toBe(false);
    }
    expect(connection.model.queue).toHaveLength(0);
  } finally {
    reader.releaseLock();
    await connection.close();
  }
});
it('cancels content when a command is already aborted', async () => {
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
      connection.remote.run(
        { routine: 'solve', values: { file: { stream } } },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    await cancelled.promise;
    expect(stream.locked).toBe(false);
    expect(connection.model.queue).toHaveLength(0);
  } finally {
    await connection.close();
  }
});
it('closes a new monitor if the connection cannot publish another reference', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 1 } });
  try {
    for (let i = 0; i < 5; i++) {
      await expect(connection.remote.monitor(output)).rejects.toMatchObject({
        code: 'resource-limit',
      });
      expect(connection.model.monitors.size).toBe(0);
    }
    expect(await connection.remote.describe()).toBeDefined();
  } finally {
    await connection.close();
  }
});
it('recycles reference slots as monitors close', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 4 } });
  const { model, remote } = connection;
  try {
    for (let i = 0; i < 20; i++) {
      const monitor = await remote.monitor(output);
      const running = reached(monitor, 'running');
      const command = remote.run({ routine: 'solve', values: {} });
      await running;
      model.frame(i);
      model.finish();
      await command;
      expect(monitor.range).toEqual([i, i]);
      await monitor.close();
    }
    expect(model.monitors.size).toBe(0);
  } finally {
    await connection.close();
  }
});
