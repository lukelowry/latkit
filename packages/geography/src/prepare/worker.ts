import { runJob, type Job } from './jobs.js';

/** The geography's worker: says it started, then runs each job it is sent and posts back its result or failure. */
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; job: Job }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = (event) => {
  const { id, job } = event.data;
  try {
    const { result, transfer } = runJob(job);
    scope.postMessage({ id, result }, transfer);
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    scope.postMessage({ id, error: { code: code ?? 'internal', message: message ?? String(error) } });
  }
};
scope.postMessage({ ready: true });
