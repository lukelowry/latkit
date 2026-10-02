import { expect, it, vi } from 'vitest';
import type { Input } from '@latkit/model';
import { LiveModel, inputPatch, transaction } from '../../model/tests/live.js';
import { byteStream, readBytes } from '../../model/tests/fixture.js';
import { open, subscribed, deferred } from './fixture.js';
const fields = [{ from: 'Node', select: ['value'] }] as const;
it.each([false, true])('isolates subscriptions across connections (framed=%s)', async (framed) => {
  const model = new LiveModel(),
    a = await open(model, framed),
    b = await open(model, framed);
  try {
    a.remote.monitor(fields);
    const other = b.remote.monitor(fields);
    await subscribed(model, 2);
    await a.close();
    await vi.waitFor(() => expect(model.subscribers.size).toBe(1));
    const published = model.publish([inputPatch()]);
    expect((await transaction(other)).at(-1)?.kind).toBe('end');
    await published;
  } finally {
    await a.remote.close();
    await b.close();
  }
});
it.each([false, true])(
  'cancels a pending pull on iterator return and recovers (framed=%s)',
  async (framed) => {
    const c = await open(undefined, framed);
    try {
      const stream = c.remote.monitor(fields)[Symbol.asyncIterator]();
      const pending = expect(stream.next()).rejects.toMatchObject({ code: 'aborted' });
      await subscribed(c.model);
      await stream.return?.();
      await pending;
      await vi.waitFor(() => expect(c.model.subscribers.size).toBe(0));
      const another = c.remote.monitor(fields);
      await subscribed(c.model);
      const publish = c.model.publish([inputPatch()]);
      await transaction(another);
      await publish;
    } finally {
      await c.close();
    }
  },
);
it.each([false, true])(
  'streams bounded command files without detaching supplied bytes (framed=%s)',
  async (framed) => {
    const model = new LiveModel();
    let received: Uint8Array | undefined;
    model.commands.run = async (command) => {
      received = await readBytes((command.values.file as Input).stream);
      return { bytes: received.length };
    };
    const c = await open(model, framed, {
        limits: { maxInFlightBytes: 16384, maxMetadataBytes: 2048 },
      }),
      bytes = Uint8Array.from({ length: 30000 }, (_, i) => i % 251);
    try {
      expect(
        await c.remote.commands!.run({
          routine: 'echo',
          values: { file: { stream: byteStream(bytes) } },
        }),
      ).toEqual({ bytes: bytes.length });
      expect(received).toEqual(bytes);
      expect(bytes.byteLength).toBe(30000);
    } finally {
      await c.close();
    }
  },
);
it('cancels an unrelated command without ending passive observation', async () => {
  const model = new LiveModel(),
    started = deferred();
  model.commands.run = async (_command, { signal } = {}) => {
    started.resolve();
    await new Promise<void>((_yes, no) =>
      signal!.addEventListener(
        'abort',
        () => no(Object.assign(new Error('aborted'), { code: 'aborted' })),
        { once: true },
      ),
    );
    return {};
  };
  const c = await open(model),
    stop = new AbortController();
  try {
    const stream = c.remote.monitor(fields);
    await subscribed(model);
    const command = c.remote.commands!.run(
      { routine: 'echo', values: {} },
      { signal: stop.signal },
    );
    const failed = expect(command).rejects.toMatchObject({ code: 'aborted' });
    await started.promise;
    stop.abort();
    await failed;
    const publish = model.publish([inputPatch()]);
    await transaction(stream);
    await publish;
    expect(model.subscribers.size).toBe(1);
  } finally {
    await c.close();
  }
});
it('disconnect cancels pending pulls and releases producer subscriptions', async () => {
  const c = await open();
  const stream = c.remote.monitor(fields)[Symbol.asyncIterator]();
  const pending = expect(stream.next()).rejects.toBeDefined();
  await subscribed(c.model);
  const closed = expect(c.remote.closed).rejects.toMatchObject({ code: 'disconnected' });
  const served = expect(c.serving).rejects.toMatchObject({ code: 'disconnected' });
  await c.server.close();
  await Promise.all([pending, closed, served]);
  await vi.waitFor(() => expect(c.model.subscribers.size).toBe(0));
  await c.remote.close();
});
