import { MessageChannel } from 'node:worker_threads';
import { connect, serve, messagePort, byteTransport } from '../src/index.js';
import type { ConnectOptions, Transport } from '../src/index.js';
import { FixtureService } from '../../model_new/tests/fixture.js';
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
export async function open(
  service = new FixtureService(),
  framed = false,
  options: ConnectOptions = {},
) {
  const [client, server] = transports(framed);
  const serving = serve(server, service, options);
  void serving.catch(() => undefined);
  const remote = await connect(client, options);
  return {
    remote,
    service,
    client,
    server,
    serving,
    async close() {
      await remote.close();
      await serving;
    },
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
