import {
  requestDevice,
  createPresentation,
  createRenderTarget,
  type SceneRenderer,
} from '@latkit/gpu';
import { createNetworkRenderer } from '@latkit/network';
import { createDiagramRenderer } from '@latkit/diagram';
import { createMonitorRenderer } from '@latkit/monitor';
import { connect, connectSeries, messagePort, type Remote } from '@latkit/port';
import type { Series } from '@latkit/model';
import {
  BufferTarget,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from 'mediabunny';
import { panels, timeline } from './config.js';
import { compositor } from './composite.js';
import { unpack } from './scenes.js';
import { writes, type Request, type Response } from './protocol.js';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Response, transfer?: ArrayBuffer[]): void;
} & Parameters<typeof messagePort>[0];
const abort = new AbortController();
let started = false;
scope.onmessage = (event) => {
  if (event.data.kind === 'cancel') {
    abort.abort();
    return;
  }
  if (event.data.kind !== 'start' || started) return;
  started = true;
  void run(event.data).then(
    (buffer) => scope.postMessage({ kind: 'done', buffer }, buffer ? [buffer] : []),
    (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      scope.postMessage({ kind: 'error', name: error.name, message: error.message });
    },
  );
};
async function run(request: Extract<Request, { kind: 'start' }>): Promise<ArrayBuffer | undefined> {
  const { config } = request;
  const { signal } = abort;
  const port = messagePort(scope);
  const sink = connect(port, writes);
  const sources: Remote<Series>[] = [];
  const renderers: SceneRenderer[] = [];
  const targets: ReturnType<typeof createRenderTarget>[] = [];
  let device: GPUDevice | undefined;
  let presentation: ReturnType<typeof createPresentation> | undefined;
  let output: Output | undefined;
  try {
    signal.throwIfAborted();
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined')
      throw new Error('This browser does not provide WebCodecs video encoding in workers');
    const codec = config.format === 'mp4' ? 'avc' : 'vp9';
    const encoding = {
      quality: new Quality(
        typeof config.quality === 'number' ? { bitrate: config.quality } : config.quality,
      ),
      latencyMode: 'quality' as const,
      hardwareAcceleration: 'no-preference' as const,
    };
    if (
      !(await canEncodeVideo(codec, {
        ...encoding,
        width: config.width,
        height: config.height,
        frameRate: config.frameRate,
      }))
    )
      throw new Error(
        `This browser cannot encode ${config.format} at ${config.width}x${config.height}, ${config.frameRate} fps`,
      );
    device = await requestDevice();
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') abort.abort(new Error(`Video GPU lost: ${info.message}`));
    });
    device.addEventListener('uncapturederror', (event) =>
      abort.abort(new Error(event.error.message)),
    );
    if (Math.max(config.width, config.height) > device.limits.maxTextureDimension2D)
      throw new RangeError('Video size exceeds the GPU texture limit');
    const canvas = new OffscreenCanvas(config.width, config.height);
    presentation = createPresentation(device, canvas, { alphaMode: 'opaque' });
    for (let id = 0; id < request.seriesCount; id++)
      sources.push(await connectSeries(port, { id: String(id), signal }));
    const views = unpack(request.views, sources);
    const regions = panels(config, views.length);
    for (const [i, scene] of views.entries()) {
      signal.throwIfAborted();
      const region = regions[i]!;
      const target = createRenderTarget(device, region.width, region.height);
      targets.push(target);
      renderers.push(
        await (scene.kind === 'network'
          ? createNetworkRenderer(target, scene)
          : scene.kind === 'diagram'
            ? createDiagramRenderer(target, scene)
            : createMonitorRenderer(target, scene)),
      );
    }
    const compose = await compositor(device, presentation.format, targets);
    const buffer = request.streaming ? undefined : new BufferTarget();
    const target =
      buffer ??
      new StreamTarget(
        new WritableStream({
          async write(chunk) {
            signal.throwIfAborted();
            // Muxer buffers may be reused. Transfer only our copy, one acknowledged chunk at a time.
            const data = chunk.data.slice();
            await sink.call({ ...chunk, data }, { signal, transfer: [data.buffer] });
          },
        }),
        { chunked: true, chunkSize: 1 << 20 },
      );
    output = new Output({
      format:
        config.format === 'mp4'
          ? new Mp4OutputFormat({ fastStart: request.streaming ? 'fragmented' : 'in-memory' })
          : new WebMOutputFormat(),
      target,
    });
    const source = new VideoSampleSource({ codec, ...encoding });
    output.addVideoTrack(source, { frameRate: config.frameRate });
    await output.start();
    const clock = timeline(config);
    let reported = -Infinity;
    for (let i = 0; i < clock.frames; i++) {
      signal.throwIfAborted();
      const frame = clock.frame(i);
      await Promise.all(renderers.map((renderer) => renderer.prepare(frame.time, signal)));
      signal.throwIfAborted();
      for (const renderer of renderers) renderer.draw(frame.timestamp / 1000);
      compose(presentation.texture(), regions, config.background);
      const sample = new VideoSample(canvas, {
        timestamp: frame.timestamp / 1e6,
        duration: frame.duration / 1e6,
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
      const now = performance.now();
      if (now - reported >= 100 || i + 1 === clock.frames) {
        reported = now;
        scope.postMessage({
          kind: 'progress',
          progress: { phase: 'rendering', completedFrames: i + 1, totalFrames: clock.frames },
        });
      }
    }
    signal.throwIfAborted();
    scope.postMessage({
      kind: 'progress',
      progress: { phase: 'finalizing', completedFrames: clock.frames, totalFrames: clock.frames },
    });
    await output.finalize();
    signal.throwIfAborted();
    return buffer?.buffer ?? undefined;
  } catch (error) {
    await output?.cancel().catch(() => undefined);
    throw signal.aborted ? signal.reason : error;
  } finally {
    for (const renderer of renderers) renderer.destroy();
    for (const target of targets) target.destroy();
    presentation?.destroy();
    device?.destroy();
    for (const series of sources) series.close();
    sink.close();
  }
}
