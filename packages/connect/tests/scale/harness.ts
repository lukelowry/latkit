import { setTimeout } from 'node:timers/promises';
import type { ConnectOptions } from '../../src/index.js';
import { Worker, MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { connect, serve, messagePort, byteTransport } from '../../src/index.js';
import type { ModelService } from '@latkit/model-new';
import { ScaleService } from '../../../model_new/tests/scale/service.js';
import type { Metrics } from '../../../model_new/tests/scale/store.js';
import { deferred } from '../../../model_new/tests/scale/store.js';
import { socketPair } from './socket.js';
import type { SocketMetrics } from './socket.js';
export const modes = ['local', 'message', 'framed', 'worker', 'socket'] as const;
export type Mode = (typeof modes)[number];
export interface Harness {
  service: ModelService;
  metrics(): Promise<Metrics>;
  pause(value: boolean): Promise<void>;
  socket: SocketMetrics;
  close(): Promise<void>;
}
let workerBundle: Promise<unknown> | undefined;
export async function prepareWorker(): Promise<string> {
  const directory = fileURLToPath(
    new URL('../../../../output/model-connect-worker', import.meta.url),
  );
  await (workerBundle ??= build({
    entry: { worker: fileURLToPath(new URL('./worker.ts', import.meta.url)) },
    outDir: directory,
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    bundle: true,
    noExternal: ['@latkit/model-new'],
    config: false,
    dts: false,
    silent: true,
    clean: false,
  }));
  return directory + '/worker.js';
}
export async function harness(
  mode: Mode,
  rows: number,
  pageRows = 8192,
  options: ConnectOptions = {},
): Promise<Harness> {
  const native = new ScaleService(rows, pageRows);
  const socket = { sentBytes: 0, receivedBytes: 0, decodedBytes: 0, maxFrameBytes: 0 };
  if (mode === 'local')
    return {
      service: native,
      metrics: async () => native.inspect(),
      pause: async (value) => native.pause(value),
      socket,
      async close() {
        native.pause(false);
        for (const core of [...native.cores.values()]) {
          for (const model of [...core.models]) await model.close();
          for (const document of [...core.documents]) await document.close();
        }
      },
    };
  if (mode === 'worker') {
    const path = await prepareWorker();
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(path, {
      workerData: { rows, pageRows, port: port2 },
      transferList: [port2],
    });
    const exit = deferred<number>();
    const pending = new Map<number, ReturnType<typeof deferred<Metrics>>>();
    let next = 0;
    let finalMetrics: Metrics | undefined;
    worker.on(
      'message',
      (message: { kind?: string; id: number; result: Metrics; metrics?: Metrics }) => {
        if (message.kind === 'final') {
          finalMetrics = message.metrics;
          return;
        }
        pending.get(message.id)?.resolve(message.result);
        pending.delete(message.id);
      },
    );
    worker.on('error', (value) => {
      const error = value instanceof Error ? value : new Error(String(value));
      exit.reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
    worker.on('exit', (code) => {
      exit.resolve(code);
      for (const request of pending.values()) request.reject(new Error('Worker exited'));
      pending.clear();
    });
    const request = async (kind: 'metrics' | 'pause', paused?: boolean): Promise<Metrics> => {
      const id = next++;
      const result = deferred<Metrics>();
      pending.set(id, result);
      worker.postMessage({ id, kind, paused });
      return result.promise;
    };
    try {
      const remote = await connect(messagePort(port1), {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(60_000),
      });
      return {
        service: remote,
        metrics: () => (finalMetrics ? Promise.resolve(finalMetrics) : request('metrics')),
        pause: async (value) => {
          await request('pause', value);
        },
        socket,
        async close() {
          try {
            await remote.close();
            const code = await exit.promise;
            if (code !== 0) throw new Error('Worker exited with ' + code);
          } finally {
            await worker.terminate();
          }
        },
      };
    } catch (error) {
      port1.close();
      await worker.terminate();
      throw error;
    }
  }
  let client, server;
  if (mode === 'socket') {
    const channels = await socketPair(socket);
    client = byteTransport(channels[0]);
    server = byteTransport(channels[1]);
  } else {
    const { port1, port2 } = new MessageChannel();
    const pair = [messagePort(port1), messagePort(port2)];
    const transports = pair.map((transport) =>
      mode === 'framed'
        ? byteTransport({
            send: (frame) => {
              socket.sentBytes += frame.byteLength;
              socket.maxFrameBytes = Math.max(socket.maxFrameBytes, frame.byteLength);
              return transport.send(frame, [frame.buffer as ArrayBuffer]);
            },
            subscribe: (receive, end) =>
              transport.subscribe((value) => {
                const frame = value as Uint8Array;
                socket.receivedBytes += frame.byteLength;
                receive(frame);
              }, end),
            close: () => transport.close(),
          })
        : transport,
    );
    [client, server] = transports;
  }
  const serving = serve(server, native);
  void serving.catch(() => undefined);
  const remote = await connect(client, options);
  return {
    service: remote,
    metrics: async () => native.inspect(),
    pause: async (value) => native.pause(value),
    socket,
    async close() {
      native.pause(false);
      await remote.close();
      try {
        await serving;
      } catch (error) {
        // Local close is immediate; TCP can report reset when cancellation traffic was still queued.
        if (
          mode !== 'socket' ||
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'disconnected'
        )
          throw error;
      }
    },
  };
}

export async function until(run: Harness, test: (value: Metrics) => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!test(await run.metrics())) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for fixture state');
    await setTimeout(1);
  }
}
