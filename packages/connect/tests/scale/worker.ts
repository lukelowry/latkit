import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { serve, messagePort } from '../../src/index.js';
import { ScaleModel } from '../../../model/tests/scale/model.js';
const data = workerData as { rows: number; pageRows: number; port: MessagePort };
const model = new ScaleModel(data.rows, data.pageRows);
parentPort!.on(
  'message',
  (request: { id: number; paused?: boolean; kind: 'metrics' | 'pause' }) => {
    if (request.kind === 'pause') model.pause(request.paused!);
    parentPort!.postMessage({ id: request.id, result: model.inspect() });
  },
);
try {
  await serve(messagePort(data.port), model);
} finally {
  model.pause(false);
  parentPort!.postMessage({ kind: 'final', metrics: model.inspect() });
  parentPort!.close();
}
