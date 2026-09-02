import { describe, expect, it, vi } from 'vitest';

import {
  connect,
  describeError,
  messagePort,
  type MessageTarget,
  protocol,
  serve,
  transferred,
} from '../src/index.js';
import { requests, str } from '../src/guard.js';
import { loopback, settle } from '../src/testing.js';

type Echo = { readonly text: string; readonly delayMs?: number };
type Count = { readonly upTo: number };

const UPPER = protocol<Echo, string, { readonly tick: number }>('upper');
const LOWER = protocol<Echo, string>('lower');
const COUNT = protocol<Count, number>('count');
const echo = (name: string) => protocol<Echo, string>(name);

/** Resolves once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe('serve and connect', () => {
  it('routes calls, progress, and events per protocol on one shared port', async () => {
    const [server, client] = loopback();
    const upper = serve(server, UPPER, async (request, _signal, progress) => {
      progress(1, 2);
      return request.text.toUpperCase();
    });
    serve(server, LOWER, async (request) => request.text.toLowerCase());

    const toUpper = connect(client, UPPER);
    const toLower = connect(client, LOWER);
    const events = vi.fn();
    const progress = vi.fn();
    toUpper.on(events);

    expect(await toUpper.call({ text: 'Mixed' }, { progress })).toBe('MIXED');
    expect(await toLower.call({ text: 'Mixed' })).toBe('mixed');
    expect(progress).toHaveBeenCalledWith(1, 2);

    upper.emit({ tick: 1 });
    await settle();
    expect(events).toHaveBeenCalledWith({ tick: 1 });
    expect(events).toHaveBeenCalledOnce();
  });

  it('delivers a transferred reply value', async () => {
    const [server, client] = loopback();
    serve(server, protocol<Echo, Uint8Array>('bytes'), async (request) => {
      const bytes = new TextEncoder().encode(request.text);
      return transferred(bytes, [bytes.buffer as ArrayBuffer]);
    });
    const bytes = await connect(client, protocol<Echo, Uint8Array>('bytes')).call({ text: 'hi' });
    expect(new TextDecoder().decode(bytes)).toBe('hi');
  });

  it('aborting a call cancels the handler and rejects with AbortError', async () => {
    const [server, client] = loopback();
    const seen = vi.fn();
    serve(
      server,
      echo('slow'),
      (request, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            seen();
            reject(signal.reason as Error);
          });
          setTimeout(() => resolve(request.text), request.delayMs ?? 0);
        }),
    );
    const connection = connect(client, echo('slow'));
    const controller = new AbortController();
    const pending = connection.call({ text: 'x', delayMs: 50 }, { signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(seen).toHaveBeenCalledOnce();
    await expect(
      connection.call({ text: 'y' }, { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('surfaces a handler failure as the call rejection and keeps serving', async () => {
    const [server, client] = loopback();
    serve(server, echo('flaky'), async (request) => {
      if (request.text === 'boom') throw new Error('kaboom');
      return request.text;
    });
    const connection = connect(client, echo('flaky'));
    await expect(connection.call({ text: 'boom' })).rejects.toThrow('kaboom');
    expect(await connection.call({ text: 'ok' })).toBe('ok');
  });

  it('a guard refuses a malformed request before the handler and keeps serving', async () => {
    type Op = { readonly op: 'echo'; readonly text: string };
    const GUARDED = protocol<Op, string>('guarded', requests<Op>({ echo: { text: str } }));
    const [server, client] = loopback();
    const handler = vi.fn(async (request: Op) => request.text);
    serve(server, GUARDED, handler);
    const raw = connect(client, protocol<unknown, unknown>('guarded'));
    await expect(raw.call({ op: 'echo', text: 5 })).rejects.toThrow('malformed guarded request');
    await expect(raw.call({ op: 'nope' })).rejects.toThrow('malformed guarded request');
    await expect(raw.call('echo')).rejects.toThrow('malformed guarded request');
    expect(handler).not.toHaveBeenCalled();
    expect(await connect(client, GUARDED).call({ op: 'echo', text: 'ok' })).toBe('ok');
  });

  it('a client close stops the service; a service close rejects the client', async () => {
    const [server, client] = loopback();
    const onClose = vi.fn();
    serve(server, echo('echo'), async (request) => request.text, { onClose });
    const connection = connect(client, echo('echo'));
    expect(await connection.call({ text: 'a' })).toBe('a');
    connection.close();
    await settle();
    expect(onClose).toHaveBeenCalledOnce();
    await expect(connection.call({ text: 'b' })).rejects.toThrow(/connection was closed/);

    const [server2, client2] = loopback();
    let release!: () => void;
    const service = serve(
      server2,
      echo('echo'),
      () => new Promise((resolve) => (release = () => resolve('late'))),
    );
    const connection2 = connect(client2, echo('echo'));
    const pending = connection2.call({ text: 'a' });
    await settle();
    expect(connection2.closed).toBeNull();
    service.close();
    await expect(pending).rejects.toThrow(/service was closed/);
    expect(connection2.closed).toMatch(/service was closed/);
    release();
  });

  it('a transport failure ends every connection on the port with its reason', async () => {
    const [server, client] = loopback();
    serve(server, echo('one'), async (request) => request.text);
    serve(server, echo('two'), async (request) => request.text);
    const one = connect(client, echo('one'));
    const two = connect(client, echo('two'));
    const pending = one.call({ text: 'x' });
    await settle(1);
    client.fail('worker crashed');
    await expect(pending).rejects.toThrow('worker crashed');
    expect(one.closed).toBe('worker crashed');
    expect(two.closed).toBe('worker crashed');
    await expect(two.call({ text: 'x' })).rejects.toThrow('worker crashed');
  });

  it('a transport failure on the served side aborts its handlers and reports the close', async () => {
    const [server, client] = loopback();
    const onClose = vi.fn();
    let signalSeen: AbortSignal | null = null;
    serve(
      server,
      echo('echo'),
      (_request, signal) => {
        signalSeen = signal;
        return new Promise(() => {});
      },
      { onClose },
    );
    void connect(client, echo('echo'))
      .call({ text: 'x' })
      .catch(() => {});
    await settle();
    server.fail('socket closed');
    expect(onClose).toHaveBeenCalledOnce();
    expect(signalSeen!.aborted).toBe(true);
  });

  it('two connections to one protocol on one port keep their replies apart', async () => {
    const [server, client] = loopback();
    serve(server, echo('echo'), async (request) => request.text);
    const a = connect(client, echo('echo'));
    const b = connect(client, echo('echo'));
    expect(await Promise.all([a.call({ text: 'a' }), b.call({ text: 'b' })])).toEqual(['a', 'b']);
  });

  it('drops events emitted after the service closed and messages for other protocols', async () => {
    const [server, client] = loopback();
    const service = serve(server, UPPER, async (request) => request.text);
    const events = vi.fn();
    connect(client, UPPER).on(events);
    server.post({ svc: 'other', kind: 'event', body: 1 });
    server.post({ svc: 'upper', kind: 'event' });
    server.post({ svc: 'upper', kind: 'reply' });
    server.post('junk');
    service.emit({ tick: 1 });
    service.close();
    service.emit({ tick: 2 });
    await settle();
    expect(events.mock.calls.map(([event]) => event as unknown)).toEqual([undefined, { tick: 1 }]);
  });
});

describe('streams', () => {
  it('streams what an async handler yields and ends with the loop', async () => {
    const [server, client] = loopback();
    serve(server, COUNT, async function* (request) {
      for (let n = 1; n <= request.upTo; n++) yield n;
    });
    expect(await collect(connect(client, COUNT).stream({ upTo: 3 }))).toEqual([1, 2, 3]);
  });

  it('streams transferred items and awaits the port drain between them', async () => {
    const [server, client] = loopback();
    const drain = vi.fn(async () => {});
    serve({ ...server, drain }, protocol<Count, Uint8Array>('bytes'), async function* (request) {
      for (let n = 1; n <= request.upTo; n++) {
        const bytes = Uint8Array.of(n);
        yield transferred(bytes, [bytes.buffer as ArrayBuffer]);
      }
    });
    const items = await collect(
      connect(client, protocol<Count, Uint8Array>('bytes')).stream({ upTo: 3 }),
    );
    expect(items.map((bytes) => bytes[0])).toEqual([1, 2, 3]);
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('leaving the loop early cancels the handler', async () => {
    const [server, client] = loopback();
    let produced = 0;
    let finished = false;
    serve(server, COUNT, async function* (_request, signal) {
      try {
        while (!signal.aborted) {
          yield ++produced;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } finally {
        finished = true;
      }
    });
    for await (const n of connect(client, COUNT).stream({ upTo: 0 })) {
      if (n >= 3) break;
    }
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(produced).toBeLessThan(10);
  });

  it('a stream ends quietly when its signal aborts, and the handler is cancelled', async () => {
    const [server, client] = loopback();
    let cancelled = false;
    serve(server, COUNT, async function* (_request, signal) {
      yield 1;
      await aborted(signal);
      cancelled = true;
      yield 2;
    });
    const controller = new AbortController();
    const seen: number[] = [];
    for await (const n of connect(client, COUNT).stream(
      { upTo: 0 },
      { signal: controller.signal },
    )) {
      seen.push(n);
      controller.abort();
    }
    expect(seen).toEqual([1]);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('a stream begun with an aborted signal or on a closed connection ends at once', async () => {
    const [server, client] = loopback();
    serve(server, COUNT, async function* () {
      yield 1;
    });
    const connection = connect(client, COUNT);
    expect(await collect(connection.stream({ upTo: 1 }, { signal: AbortSignal.abort() }))).toEqual(
      [],
    );
    connection.close();
    await expect(collect(connection.stream({ upTo: 1 }))).rejects.toThrow(/connection was closed/);
  });

  it('a handler failure mid-stream rejects the iteration after the items before it', async () => {
    const [server, client] = loopback();
    serve(server, COUNT, async function* () {
      yield 1;
      throw new Error('boom');
    });
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const n of connect(client, COUNT).stream({ upTo: 0 })) seen.push(n);
      })(),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1]);
  });

  it('a transport failure mid-stream rejects the iteration with its reason', async () => {
    const [server, client] = loopback();
    serve(server, COUNT, async function* (_request, signal) {
      yield 1;
      await aborted(signal);
    });
    const stream = connect(client, COUNT).stream({ upTo: 0 })[Symbol.asyncIterator]();
    expect((await stream.next()).value).toBe(1);
    const pending = stream.next();
    client.fail('worker crashed');
    await expect(pending).rejects.toThrow('worker crashed');
  });

  it('call() on a streaming handler rejects and cancels it', async () => {
    const [server, client] = loopback();
    let cancelled = false;
    serve(server, COUNT, async function* (_request, signal) {
      yield 1;
      await aborted(signal);
      cancelled = true;
    });
    await expect(connect(client, COUNT).call({ upTo: 1 })).rejects.toThrow(
      'count streams this request; use stream()',
    );
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('stream() on a single-reply handler yields the one reply', async () => {
    const [server, client] = loopback();
    serve(server, echo('once'), async (request) => request.text);
    expect(await collect(connect(client, echo('once')).stream({ text: 'hi' }))).toEqual(['hi']);
  });

  it('a stream iterates once', async () => {
    const [server, client] = loopback();
    serve(server, COUNT, async function* () {
      yield 1;
    });
    const stream = connect(client, COUNT).stream({ upTo: 1 });
    expect(await collect(stream)).toEqual([1]);
    await expect(collect(stream)).rejects.toThrow('a stream iterates once');
  });
});

describe('transfer', () => {
  /** A `MessagePort` as a message target; it has no `error` event, so that listener stays inert. */
  function target(port: MessagePort): MessageTarget {
    return {
      postMessage: (message, transfer) => port.postMessage(message, transfer),
      addEventListener: (type: string, listener: (event: never) => void) =>
        port.addEventListener(type, listener as EventListener),
      removeEventListener: (type: string, listener: (event: never) => void) =>
        port.removeEventListener(type, listener as EventListener),
    };
  }

  it('detaches transferred buffers on both sides of a real message channel', async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const BYTES = protocol<Uint8Array, Uint8Array>('bytes');
    let kept: Uint8Array | null = null;
    serve(messagePort(target(channel.port1)), BYTES, async (request) => {
      kept = Uint8Array.of(request.byteLength, ...request);
      return transferred(kept, [kept.buffer as ArrayBuffer]);
    });
    const connection = connect(messagePort(target(channel.port2)), BYTES);
    const command = Uint8Array.of(1, 2, 3);
    const reply = await connection.call(command, { transfer: [command.buffer as ArrayBuffer] });
    expect(Array.from(reply)).toEqual([3, 1, 2, 3]);
    expect(command.byteLength).toBe(0);
    expect(kept!.byteLength).toBe(0);
    connection.close();
    channel.port1.close();
    channel.port2.close();
  });
});

describe('describeError', () => {
  it('unfolds aggregate errors and stringifies anything else', () => {
    expect(describeError(new Error('a'))).toBe('a');
    expect(describeError('plain')).toBe('plain');
    expect(describeError(new AggregateError([new Error('x'), 'y'], 'both'))).toBe('both (x; y)');
    expect(describeError(new AggregateError([], 'none'))).toBe('none');
  });
});
