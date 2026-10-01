import type { RequestOptions } from '@latkit/model';
import { createPresentation, GpuError, type Gpu, type Renderer } from '@latkit/gpu';
import { VideoSample } from 'mediabunny';
import { settings, timeline } from './timing.js';
import { encoding } from './encoding.js';
import { destination } from './output.js';
import { wait } from './wait.js';
import { observeLoss } from './loss.js';

/** Positional writes. Bytes remain immutable after write resolves; the destination owns retention. */
export interface VideoWrite {
  readonly position: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}
export interface VideoProgress {
  readonly phase: 'rendering' | 'finalizing';
  readonly completedFrames: number;
  readonly totalFrames: number;
}
export interface VideoOptions extends RequestOptions {
  readonly gpu: Gpu;
  /** Borrowed exclusively for this export; use a dedicated view over retained sources. */
  readonly renderer: Renderer;
  readonly width: number;
  readonly height: number;
  /** Output duration in seconds, including a possibly shorter final frame. */
  readonly duration: number;
  /** Defaults to 60. */
  readonly frameRate?: number;
  /** Maps output seconds to a model coordinate. Omit for static data; effects still receive output time. */
  readonly at?: (seconds: number) => number;
  readonly format?: 'mp4' | 'webm';
  readonly quality?: 'medium' | 'high' | 'very-high';
  /** Explicit target bits/second, instead of quality. */
  readonly bitrate?: number;
  /** Borrowed writer lock. The caller closes or aborts the destination. */
  readonly output: WritableStream<VideoWrite>;
  readonly onProgress?: (progress: VideoProgress) => void;
}
export interface VideoResult {
  readonly frames: number;
  readonly duration: number;
  readonly byteLength: number;
  readonly mediaType: string;
}
const active = new WeakSet<Renderer>();
/** GPU preparation, capture, encoder and destination backpressure form one bounded pipeline. */
export async function exportVideo(options: VideoOptions): Promise<VideoResult> {
  const config = settings(options);
  if (active.has(options.renderer)) throw new GpuError('busy', 'Renderer is already exporting');
  options.signal?.throwIfAborted();
  active.add(options.renderer);
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, ...(options.signal ? [options.signal] : [])]);
  const releaseLoss = observeLoss(options.gpu, stop);
  const error = (event: GPUUncapturedErrorEvent) => stop.abort(event.error);
  options.gpu.device.addEventListener('uncapturederror', error);
  let presentation: ReturnType<typeof createPresentation> | undefined;
  let sink: ReturnType<typeof destination> | undefined;
  let media: Awaited<ReturnType<typeof encoding>> | undefined;
  try {
    // Negotiate before acquiring a destination or allocating capture textures.
    media = await wait(encoding(config), signal);
    signal.throwIfAborted();
    sink = destination(options.output, signal);
    media.open(sink.stream);
    const canvas = new OffscreenCanvas(config.width, config.height);
    presentation = createPresentation({ gpu: options.gpu, canvas, alphaMode: 'opaque' });
    await wait(media.start(), signal);
    let reported = -Infinity;
    for (let i = 0; i < config.frames; i++) {
      signal.throwIfAborted();
      const frame = timeline(config, i);
      const at = options.at?.(frame.seconds);
      if (at !== undefined && !Number.isFinite(at))
        throw new GpuError('invalid-input', 'Video coordinate must be finite');
      await options.gpu.render({
        completion: 'complete',
        signal,
        timeMs: frame.seconds * 1000,
        views: [{ renderer: options.renderer, target: presentation, at }],
      });
      signal.throwIfAborted();
      const sample = new VideoSample(canvas, {
        timestamp: frame.timestamp / 1e6,
        duration: frame.duration / 1e6,
      });
      try {
        await wait(media.add(sample, i % config.keyFrames === 0), signal);
      } finally {
        sample.close();
      }
      const now = performance.now();
      if (now - reported >= 100 || i + 1 === config.frames) {
        reported = now;
        options.onProgress?.({
          phase: 'rendering',
          completedFrames: i + 1,
          totalFrames: config.frames,
        });
      }
    }
    options.onProgress?.({
      phase: 'finalizing',
      completedFrames: config.frames,
      totalFrames: config.frames,
    });
    await wait(media.finish(), signal);
    signal.throwIfAborted();
    return {
      frames: config.frames,
      duration: config.durationUs / 1e6,
      byteLength: sink.byteLength,
      mediaType: config.format === 'mp4' ? 'video/mp4' : 'video/webm',
    };
  } catch (cause) {
    stop.abort(cause);
    // Our private stream rejects pending writes on abort, even if a borrowed destination stalls.
    await media?.cancel().catch(() => {});
    throw signal.aborted ? signal.reason : cause;
  } finally {
    releaseLoss();
    presentation?.destroy();
    sink?.release();
    options.gpu.device.removeEventListener('uncapturederror', error);
    active.delete(options.renderer);
  }
}
