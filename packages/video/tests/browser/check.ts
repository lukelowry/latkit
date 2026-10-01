import { ownership, throughput } from './scaling.js';
import { createGpu, createComposition, type Renderer } from '@latkit/gpu';
import { exportVideo, type VideoWrite } from '../../src/index.js';
import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from 'mediabunny';
const assert = (test: unknown, message: string) => {
  if (!test) throw new Error(message);
};
function solid(color: readonly [number, number, number, number], progressive = false): Renderer {
  let time = -1,
    steps = 0;
  return {
    get pending() {
      return progressive && steps < 3 ? Promise.resolve() : undefined;
    },
    async prepare(frame) {
      if (frame.timeMs !== time) {
        time = frame.timeMs;
        steps = 0;
      }
      steps++;
    },
    encode(frame) {
      const pass = frame.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: frame.target,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: progressive && steps < 3 ? [0, 0, 0, 1] : color,
          },
        ],
      });
      pass.end();
    },
    destroy() {},
  };
}
function memory() {
  let size = 0,
    writes = 0,
    peakWrite = 0;
  const chunks: VideoWrite[] = [];
  const stream = new WritableStream<VideoWrite>({
    write(chunk) {
      chunks.push(chunk);
      writes++;
      peakWrite = Math.max(peakWrite, chunk.bytes.byteLength);
      size = Math.max(size, chunk.position + chunk.bytes.byteLength);
    },
  });
  return {
    stream,
    blob(type: string) {
      const bytes = new Uint8Array(size);
      for (const c of chunks) bytes.set(c.bytes, c.position);
      return new Blob([bytes], { type });
    },
    stats: () => ({ size, writes, peakWrite }),
  };
}
async function rejects(promise: Promise<unknown>, word: string) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      promise.then(
        () => {
          throw new Error('Unexpected success');
        },
        (error) => {
          assert(String(error).includes(word), `Unexpected rejection: ${error}`);
        },
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation did not settle')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export async function check() {
  const NativeEncoder = globalThis.VideoEncoder;
  const encoders = new Set<VideoEncoder>();
  let peakQueue = 0;
  globalThis.VideoEncoder = class extends NativeEncoder {
    constructor(config: VideoEncoderInit) {
      super(config);
      encoders.add(this);
    }
    override encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions) {
      super.encode(frame, options);
      peakQueue = Math.max(peakQueue, this.encodeQueueSize);
    }
    override close() {
      try {
        super.close();
      } finally {
        encoders.delete(this);
      }
    }
  };
  const report: unknown[] = [],
    errors: string[] = [];
  const gpu = await createGpu();
  gpu.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  try {
    const top = solid([1, 0, 0, 1], true),
      bottom = solid([0, 1, 0, 1]);
    const renderer = createComposition({
      gpu,
      views: [
        { renderer: top, region: { x: 0, y: 0, width: 1, height: 0.5 } },
        { renderer: bottom, region: { x: 0, y: 0.5, width: 1, height: 0.5 } },
      ],
    });
    try {
      for (const format of ['mp4', 'webm'] as const) {
        const output = memory(),
          seen: number[] = [];
        const result = await exportVideo({
          gpu,
          renderer,
          output: output.stream,
          width: 320,
          height: 180,
          duration: 1.015,
          frameRate: 30,
          format,
          at: (seconds) => {
            seen.push(seconds);
            return 10 + seconds;
          },
        });
        assert(!output.stream.locked, 'Writer lock leaked');
        assert(
          result.frames === 31 && result.byteLength === output.stats().size,
          'Wrong output extent',
        );
        const blob = output.blob(result.mediaType);
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        try {
          const track = await input.getPrimaryVideoTrack();
          assert(track?.displayWidth === 320 && track.displayHeight === 180, 'Dimensions');
          // WebM SimpleBlock omits final packet duration; the segment stores the output end.
          const duration =
            format === 'webm'
              ? await input.getDurationFromMetadata()
              : await input.computeDuration();
          assert(
            Math.abs(duration! - 1.015) < 0.003,
            `Fractional duration (${format}): ${duration}`,
          );
          const sink = new VideoSampleSink(track!),
            canvas = new OffscreenCanvas(320, 180),
            context = canvas.getContext('2d', { willReadFrequently: true })!;
          for (const at of [0, 0.5, 1.01]) {
            const frame = await sink.getSample(at);
            assert(frame, 'Missing decoded sample');
            try {
              frame!.draw(context, 0, 0);
              const red = context.getImageData(160, 30, 1, 1).data,
                green = context.getImageData(160, 140, 1, 1).data;
              assert(
                red[0]! > 180 && red[1]! < 70 && green[1]! > 180 && green[0]! < 70,
                'Composition or progressive completion failed',
              );
            } finally {
              frame?.close();
            }
          }
          report.push({ format, frames: result.frames, duration, ...output.stats() });
        } finally {
          input.dispose();
        }
        assert(seen[0] === 0 && seen[30] === 1, 'Coordinate scheduling drift');
        assert(encoders.size === 0, 'Encoder leaked after success');
      }
      for (const duration of [1, 10]) {
        let peakWrite = 0,
          writes = 0,
          active = 0,
          peakActive = 0;
        const output = new WritableStream<VideoWrite>({
          async write(chunk) {
            active++;
            peakActive = Math.max(peakActive, active);
            writes++;
            peakWrite = Math.max(peakWrite, chunk.bytes.length);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active--;
          },
        });
        const begin = performance.now();
        const result = await exportVideo({
          gpu,
          renderer,
          output,
          width: 1920,
          height: 1080,
          duration,
          frameRate: 30,
        });
        assert(peakActive === 1 && peakWrite <= 256 * 1024, 'Unbounded writer queue');
        report.push({
          benchmark: '1080p composed progressive',
          duration,
          frames: result.frames,
          elapsedMs: performance.now() - begin,
          peakWrite,
          writes,
          gpu: gpu.stats(),
        });
      }
      const stop = new AbortController();
      let entered!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const output = new WritableStream<VideoWrite>({
        write() {
          entered();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      });
      const pending = exportVideo({
        gpu,
        renderer,
        output,
        width: 320,
        height: 180,
        duration: 10,
        signal: stop.signal,
      });
      const observed = rejects(pending, 'stalled');
      await writing;
      stop.abort(new Error('stalled'));
      await observed;
      assert(!output.locked && encoders.size === 0, 'Cancellation leaked writer or encoder');
      release();
      const broken = new WritableStream<VideoWrite>({
        write() {
          throw new Error('disk full');
        },
      });
      await rejects(
        exportVideo({ gpu, renderer, output: broken, width: 320, height: 180, duration: 1 }),
        'disk full',
      );
      assert(!broken.locked && encoders.size === 0, 'Failed write leaked resources');
      await rejects(
        exportVideo({
          gpu,
          renderer,
          output: new WritableStream(),
          width: 320,
          height: 180,
          duration: 1,
          onProgress() {
            throw new Error('progress failed');
          },
        }),
        'progress failed',
      );
      assert(encoders.size === 0, 'Progress failure leaked encoder');
      await ownership(gpu);
      report.push(...(await throughput(gpu)));
      assert(peakQueue <= 4, `Encoder queue exceeded bound: ${peakQueue}`);
      report.push({
        cancellation: 'passed',
        failedWrites: 'passed',
        progressFailure: 'passed',
        peakQueue,
      });
    } finally {
      renderer.destroy();
    }
    assert(!errors.length, errors.join('\n'));
    return report;
  } finally {
    gpu.destroy();
    globalThis.VideoEncoder = NativeEncoder;
  }
}
