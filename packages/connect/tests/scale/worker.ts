import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { serve, messagePort } from '../../src/index.js';
import { ScaleService } from '../../../model_new/tests/scale/service.js';
const data = workerData as { rows: number; pageRows: number; port: MessagePort };
const service = new ScaleService(data.rows, data.pageRows);
parentPort!.on(
  'message',
  (request: { id: number; paused?: boolean; kind: 'metrics' | 'pause' }) => {
    if (request.kind === 'pause') service.pause(request.paused!);
    parentPort!.postMessage({ id: request.id, result: service.inspect() });
  },
);
try {
  await serve(messagePort(data.port), service);
} finally {
  service.pause(false);
  parentPort!.postMessage({ kind: 'final', metrics: service.inspect() });
  parentPort!.close();
}
