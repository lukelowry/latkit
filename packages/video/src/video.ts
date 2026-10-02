import type { RequestOptions } from '@latkit/model';
import { GpuError, kit, type View } from '@latkit/gpu';
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
const active = new WeakSet<object>();
/**
 * Record a view: one bounded pipeline of frame preparation, capture, encoding and destination
 * backpressure. The view's canvas pauses until the export settles.
 */
export async function exportVideo(view: View, options: VideoOptions): Promise<VideoResult> {
  const gpu = kit.gpuOf(view),
    renderer = kit.rendererOf(view),
    config = settings(options, gpu.device.limits.maxTextureDimension2D);
  if (active.has(view)) throw new GpuError('busy', 'View is already exporting');
  options.signal?.throwIfAborted();
  active.add(view);
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, ...(options.signal ? [options.signal] : [])]);
  const releaseLoss = observeLoss(gpu, stop);
  const error = (event: GPUUncapturedErrorEvent) => stop.abort(event.error);
  gpu.device.addEventListener('uncapturederror', error);
  let release: (() => void) | undefined;
  let presentation: kit.Presentation | undefined;
  let sink: ReturnType<typeof destination> | undefined;
  let media: Awaited<ReturnType<typeof encoding>> | undefined;
  try {
    // Negotiate before acquiring a destination or allocating capture textures.
    media = await wait(encoding(config), signal);
    const holding = kit.hold(view);
    // A hold granted after cancellation is released at once.
    release = await wait(holding, signal).catch((cause: unknown) => {
      void holding.then((late) => late());
      throw cause;
    });
    signal.throwIfAborted();
    sink = destination(options.output, signal);
    media.open(sink.stream);
    const canvas = new OffscreenCanvas(config.width, config.height);
    presentation = kit.createPresentation({ gpu, canvas, alphaMode: 'opaque' });
    await wait(media.start(), signal);
    let reported = -Infinity;
    for (let i = 0; i < config.frames; i++) {
      signal.throwIfAborted();
      const frame = timeline(config, i);
      const at = options.at?.(frame.seconds);
      if (at !== undefined && !Number.isFinite(at))
        throw new GpuError('invalid-input', 'Video coordinate must be finite');
      await gpu.render({
        completion: 'complete',
        signal,
        timeMs: frame.seconds * 1000,
        views: [{ renderer, target: presentation, at }],
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
    gpu.device.removeEventListener('uncapturederror', error);
    release?.();
    active.delete(view);
  }
}
