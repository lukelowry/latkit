import type { ExportRequest, WorkerRequest, WorkerResult } from './messages.js';
import { createGpu } from '@latkit/gpu';
import { exportVideo, type VideoWrite } from '@latkit/video';
import { scene } from './scene.js';
let current: AbortController | undefined;
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.kind === 'cancel') {
    current?.abort(new DOMException('Cancelled', 'AbortError'));
    return;
  }
  if (current) return;
  current = new AbortController();
  void run(event.data, current.signal).then(
    (message) => {
      current = undefined;
      self.postMessage(message);
    },
    (error) => {
      current = undefined;
      self.postMessage({ kind: 'error', message: String(error) });
    },
  );
};
async function run(request: ExportRequest, signal: AbortSignal): Promise<WorkerResult> {
  let gpu: Awaited<ReturnType<typeof createGpu>> | undefined;
  let content: Awaited<ReturnType<typeof scene>> | undefined;
  let file: FileSystemWritableFileStream | undefined;
  try {
    gpu = await createGpu();
    content = await scene(gpu, request.view);
    const directory = await navigator.storage.getDirectory();
    const handle = await directory.getFileHandle(request.filename, { create: true });
    file = await handle.createWritable();
    const destination = file;
    const output = new WritableStream<VideoWrite>({
      write: ({ position, bytes }) => destination.write({ type: 'write', position, data: bytes }),
    });
    const began = performance.now();
    const result = await exportVideo(content.view, {
      output,
      width: 1280,
      height: 720,
      duration: request.duration,
      frameRate: 30,
      at: (seconds) => seconds,
      format: request.format,
      signal,
      onProgress: (progress) => self.postMessage({ kind: 'progress', progress }),
    });
    await file.close();
    file = undefined;
    return {
      kind: 'done',
      result,
      filename: request.filename,
      elapsedMs: performance.now() - began,
      gpu: gpu.stats(),
    };
  } catch (error) {
    await file?.abort().catch(() => {});
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await content?.close();
    } finally {
      gpu?.destroy();
    }
  }
}
