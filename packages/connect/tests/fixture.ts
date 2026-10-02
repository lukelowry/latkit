import { MessageChannel } from 'node:worker_threads';
import { connect, serve, messagePort, byteTransport } from '../src/index.js';
import type { ConnectOptions, Transport } from '../src/index.js';
import { LiveModel } from '../../model/tests/live.js';
export function transports(framed = false): [Transport, Transport] {
  const { port1, port2 } = new MessageChannel();
  const pair = [messagePort(port1), messagePort(port2)];
  return pair.map((raw) =>
    framed
      ? byteTransport({
          send: (frame) => raw.send(frame, [frame.buffer as ArrayBuffer]),
          subscribe: (receive, end) => raw.subscribe((value) => receive(value as Uint8Array), end),
          close: () => raw.close(),
        })
      : raw,
  ) as [Transport, Transport];
}
export async function connected(
  framed = false,
  model = new LiveModel(),
  options: ConnectOptions = {},
) {
  const [server, client] = transports(framed);
  const serving = serve(server, model, { ...options, commands: model.commands });
  const remote = await connect(client, options);
  void serving.catch(() => undefined);
  return {
    model,
    remote,
    server,
    serving,
    async close() {
      await remote.close();
      await serving;
    },
  };
}
export async function subscribed(model: LiveModel, count = 1): Promise<void> {
  for (let i = 0; model.subscribers.size < count; i++) {
    if (i > 1000) throw new Error('Subscription not established');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function open(model = new LiveModel(), framed = false, options: ConnectOptions = {}) {
  return connected(framed, model, options);
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
