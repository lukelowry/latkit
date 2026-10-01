import { describe, expect, it, vi } from 'vitest';
import type { FieldSelection, Input } from '@latkit/model';
import { FixtureModel, collect, byteStream, readBytes } from '../../model/tests/fixture.js';
import { open, deferred, reached } from './fixture.js';
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
const solve = { routine: 'solve', values: {} } as const;
describe.each([false, true])('transport framing=%s', (framed) => {
  it('shares one model across peers, each with monitors of its own', async () => {
    const model = new FixtureModel();
    const host = await open(model, framed);
    const page = await open(model, framed);
    try {
      const mine = await host.remote.monitor(output);
      const theirs = await page.remote.monitor(output);
      const running = reached(theirs, 'running');
      const command = host.remote.run(solve);
      await running;
      model.frame(0);
      model.finish();
      await command;
      await reached(theirs, 'complete');
      expect(mine.frames).toBe(1);
      expect(theirs.frames).toBe(1);
      const replaced = deferred();
      page.remote.on('change', (update) => {
        if (update.kind === 'replace') replaced.resolve();
      });
      model.replace(new Float64Array([5, 6, 7, 8]));
      await replaced.promise;
      expect(page.remote.version).toBe(model.version);
      await host.close();
      expect(model.monitors.size).toBe(1);
      expect(await theirs.describe()).toBeDefined();
    } finally {
      await host.close();
      await page.close();
    }
  });
  it('cancels a pending query pull and releases the producer on iterator return', async () => {
    const connection = await open(undefined, framed);
    try {
      const iterator = connection.remote.query(rows)[Symbol.asyncIterator]();
      await iterator.next();
      connection.model.readGate = new Promise(() => {});
      const pending = expect(iterator.next()).rejects.toMatchObject({ code: 'aborted' });
      await iterator.return?.();
      await pending;
      expect(connection.model.released).toBe(1);
      connection.model.readGate = undefined;
      expect(await collect(connection.remote.query(rows))).toHaveLength(2);
    } finally {
      await connection.close();
    }
  });
  it('cancels queued and running commands while the model carries on', async () => {
    const connection = await open(undefined, framed);
    const { model, remote } = connection;
    try {
      const monitor = await remote.monitor(output);
      const running = reached(monitor, 'running');
      const ahead = remote.run(solve);
      await running;
      const controller = new AbortController();
      const queued = remote.run(solve, { signal: controller.signal });
      await vi.waitFor(() => expect(model.queue).toHaveLength(2));
      controller.abort();
      await expect(queued).rejects.toMatchObject({ code: 'aborted' });
      await vi.waitFor(() => expect(model.queue).toHaveLength(1));
      model.finish();
      await ahead;
      const started = reached(monitor, 'running');
      const stop = new AbortController();
      const current = remote.run(solve, { signal: stop.signal });
      await started;
      model.frame(0);
      stop.abort();
      await expect(current).rejects.toMatchObject({ code: 'aborted' });
      await reached(monitor, 'cancelled');
      expect(monitor.frames).toBe(1);
      expect(model.queue).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });
  it('moves bounded content streams into a command without detaching supplied chunks', async () => {
    const model = new FixtureModel();
    let received: Uint8Array | undefined;
    model.run = async (command) => {
      received = await readBytes((command.values.file as Input).stream);
      return { bytes: received.length };
    };
    const connection = await open(model, framed, {
      limits: { maxInFlightBytes: 16 * 1024, maxMetadataBytes: 2048 },
    });
    const data = new TextEncoder().encode(
      JSON.stringify(Array.from({ length: 5000 }, (_, i) => i)),
    );
    try {
      expect(data.length).toBeGreaterThan(16000);
      const file = { mediaType: 'application/json', stream: byteStream(data) };
      expect(await connection.remote.run({ routine: 'solve', values: { file } })).toEqual({
        bytes: data.length,
      });
      expect(received).toEqual(data);
      expect(data.byteLength).toBeGreaterThan(16000);
    } finally {
      await connection.close();
    }
  });
  it('exports what a monitor holds as a bounded stream', async () => {
    const connection = await open(undefined, framed, {
      limits: { maxInFlightBytes: 16 * 1024, maxMetadataBytes: 2048 },
    });
    const { model, remote } = connection;
    try {
      const monitor = await remote.monitor(output);
      const running = reached(monitor, 'running');
      const command = remote.run(solve);
      await running;
      // Each frame is an event; a bounded connection fails rather than queue them without limit.
      for (let t = 0; t < 500; t++) {
        model.frame(t);
        if (t % 10 === 9) await new Promise((resolve) => setImmediate(resolve));
      }
      model.finish();
      await command;
      const [local] = [...model.monitors];
      const exported = await monitor.export();
      expect(exported.mediaType).toBe('application/vnd.latkit.test+json');
      const bytes = await readBytes(exported.stream);
      expect(bytes.length).toBeGreaterThan(16 * 1024);
      expect(bytes).toEqual(await readBytes((await local.export()).stream));
    } finally {
      await connection.close();
    }
  });
  it('enforces active stream limits and recovers after early release', async () => {
    const connection = await open(undefined, framed, {
      limits: { maxStreams: 1, maxReferences: 12 },
    });
    try {
      const first = connection.remote.query(rows)[Symbol.asyncIterator]();
      await first.next();
      await expect(
        connection.remote.query(rows)[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({ code: 'resource-limit' });
      await first.return?.();
      for (let i = 0; i < 20; i++)
        expect(await collect(connection.remote.query(rows))).toHaveLength(2);
    } finally {
      await connection.close();
    }
  });
  it('preserves independent owned blocks under a tight payload bound', async () => {
    const connection = await open(undefined, framed);
    try {
      const blocks = await collect(
        connection.remote.query(rows, { buffers: 'owned', maxBlockBytes: 300 }),
      );
      const first = blocks[0].columns.value;
      if (first.kind !== 'numeric') throw new Error('numeric');
      structuredClone(first.values, { transfer: [first.values.buffer as ArrayBuffer] });
      const second = blocks[1].columns.value;
      if (second.kind !== 'numeric') throw new Error('numeric');
      expect([...second.values]).toEqual([3, 4]);
      expect(connection.model.inputs.values.byteLength).toBe(32);
    } finally {
      await connection.close();
    }
  });
});
it('cancels the commands of a peer that goes and closes its monitors, while the model carries on', async () => {
  const model = new FixtureModel();
  const leaving = await open(model);
  const staying = await open(model);
  try {
    const watching = await staying.remote.monitor(output);
    await leaving.remote.monitor(output);
    const running = reached(watching, 'running');
    const command = leaving.remote.run(solve);
    void command.catch(() => undefined);
    await running;
    model.frame(0);
    await leaving.server.close();
    await reached(watching, 'cancelled');
    await vi.waitFor(() => expect(model.monitors.size).toBe(1));
    expect(watching.frames).toBe(1);
    expect(await collect(staying.remote.query(rows))).toHaveLength(2);
  } finally {
    await leaving.remote.close();
    await staying.close();
  }
});
it('rejects pending operations and closes monitors when the transport disappears', async () => {
  const connection = await open();
  const monitor = await connection.remote.monitor(output);
  const running = reached(monitor, 'running');
  const command = connection.remote.run(solve);
  await running;
  const changes: string[] = [];
  monitor.on('change', (update) => changes.push(update.kind));
  const stopped = expect(command).rejects.toMatchObject({ code: 'disconnected' });
  const closed = expect(connection.remote.closed).rejects.toMatchObject({ code: 'disconnected' });
  await connection.server.close();
  await Promise.all([stopped, closed]);
  await expect(connection.serving).rejects.toMatchObject({ code: 'disconnected' });
  expect(changes).toContain('closed');
  await connection.remote.close();
});
it('pins a fresh version for each iteration of the same query', async () => {
  const connection = await open();
  try {
    const query = connection.remote.query(rows);
    const before = await collect(query);
    connection.model.replace(new Float64Array([10, 2, 3, 4]));
    const after = await collect(query);
    expect(after).toHaveLength(2);
    expect(after[0].version).not.toBe(before[0].version);
  } finally {
    await connection.close();
  }
});
