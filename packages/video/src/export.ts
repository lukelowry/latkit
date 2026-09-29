import { messagePort, serve, serveSeries } from '@latkit/port';
import { configure } from './config.js';
import { pack } from './scenes.js';
import { writes, type Request, type Response } from './protocol.js';
import type { Options, VideoWrite } from './types.js';

/** Export to memory. The caller owns the returned Blob. */
export function exportVideo(options: Options & { readonly output?: undefined }): Promise<Blob>;
/** Export to a positional sink, closed on success with abort requested on failure. */
export function exportVideo(
  options: Options & { readonly output: WritableStream<VideoWrite> },
): Promise<void>;
/** Export options assembled by a host, with a runtime-selected destination. */
export function exportVideo(options: Options): Promise<Blob | void>;
export async function exportVideo(options: Options): Promise<Blob | void> {
  const config = configure(options);
  options.signal?.throwIfAborted();
  const packed = pack(options.views);
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    type: 'module',
    name: 'latkit-video',
  });
  const port = messagePort(worker);
  const releases: (() => void)[] = [];
  let writer: WritableStreamDefaultWriter<VideoWrite> | undefined;
  let abort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rendered = false;
  let fail!: (cause: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    fail = (cause) => {
      const error: unknown = options.signal?.aborted ? options.signal.reason : cause;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
  });
  try {
    writer = options.output?.getWriter();
    for (const [id, series] of packed.series.entries())
      releases.push(serveSeries(port, series, { id: String(id), snapshot: true }));
    if (writer) {
      const destination = writer;
      const service = serve(port, writes, (chunk) => destination.write(chunk));
      releases.push(() => service.close());
    }
    const completed = new Promise<ArrayBuffer | undefined>((resolve) => {
      worker.onerror = (event) => fail(new Error(event.message || 'Video worker failed to load'));
      worker.onmessageerror = () => fail(new Error('Video worker returned an unreadable message'));
      worker.onmessage = (event: MessageEvent<Response>) => {
        const message = event.data;
        if (message.kind === 'done') {
          rendered = true;
          resolve(message.buffer);
        } else if (message.kind === 'error') {
          const error = new Error(message.message);
          error.name = message.name;
          fail(error);
        } else if (message.kind === 'progress') {
          try {
            options.onProgress?.(message.progress);
          } catch (error) {
            worker.postMessage({ kind: 'cancel' } satisfies Request);
            fail(error);
          }
        }
      };
      abort = () => {
        // Signal cooperative sinks immediately; their abort promise may wait on stalled I/O.
        void writer?.abort(options.signal?.reason).catch(() => undefined);
        if (rendered) {
          fail(options.signal?.reason);
          return;
        }
        worker.postMessage({ kind: 'cancel' } satisfies Request);
        // Give an active worker time to release its resources, with a deadline for stalled drivers.
        timer = setTimeout(() => fail(options.signal?.reason), 5000);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({
        kind: 'start',
        config,
        views: packed.views,
        seriesCount: packed.series.length,
        streaming: !!writer,
      } satisfies Request);
      if (options.signal?.aborted) abort();
    });
    const buffer = await Promise.race([completed, failed]);
    options.signal?.throwIfAborted();
    if (writer) {
      await Promise.race([writer.close(), failed]);
      options.signal?.throwIfAborted();
    } else {
      if (!buffer) throw new Error('Video export returned no data');
      return new Blob([buffer], { type: config.format === 'mp4' ? 'video/mp4' : 'video/webm' });
    }
  } catch (error) {
    // An arbitrary sink must never hold the worker, services, or stream lock alive.
    void writer?.abort(error).catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
    for (const release of releases) release();
    worker.terminate();
    writer?.releaseLock();
  }
}
