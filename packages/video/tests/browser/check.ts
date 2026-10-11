import { ownership, throughput } from './scaling.js';
import { createGpu, createComposition, type Gpu, type View } from '@latkit/gpu';
import { view } from './views.js';
import { exportVideo, type VideoWrite } from '../../src/index.js';
import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from 'mediabunny';
const assert = (test: unknown, message: string) => {
  if (!test) throw new Error(message);
};
function solid(
  gpu: Gpu,
  color: readonly [number, number, number, number],
  progressive = false,
): View {
  let time = -1,
    steps = 0;
  return view(gpu, {
    pending: () => (progressive && steps < 3 ? Promise.resolve() : undefined),
    prepare(frame) {
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
  });
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
/**
 * An async `at` readies each frame's views before the frame draws, and is asked while the frame
 * before encodes; a coordinate that fails ends the export, leaking nothing.
 */
async function readied(
  gpu: Gpu,
  open: () => number,
  onEncode: (hook: () => void) => void,
): Promise<unknown> {
  let color = [1, 0, 0, 1];
  const shown = view(gpu, {
    encode(frame) {
      frame.encoder
        .beginRenderPass({
          colorAttachments: [
            { view: frame.target, loadOp: 'clear', storeOp: 'store', clearValue: color },
          ],
        })
        .end();
    },
  });
  try {
    let asked = 0,
      askedBeforeEncode = 0;
    onEncode(() => {
      askedBeforeEncode ||= asked;
    });
    const output = memory();
    const result = await exportVideo(shown, {
      output: output.stream,
      width: 320,
      height: 180,
      duration: 1,
      frameRate: 30,
      at: async (seconds, signal) => {
        asked++;
        await new Promise((resolve) => setTimeout(resolve, 2));
        signal.throwIfAborted();
        color = seconds < 0.5 ? [1, 0, 0, 1] : [0, 0, 1, 1];
        return seconds;
      },
    });
    const input = new Input({
      source: new BlobSource(output.blob(result.mediaType)),
      formats: ALL_FORMATS,
    });
    try {
      const sink = new VideoSampleSink((await input.getPrimaryVideoTrack())!),
        canvas = new OffscreenCanvas(320, 180),
        context = canvas.getContext('2d', { willReadFrequently: true })!;
      for (const [at, red] of [
        [0.2, true],
        [0.8, false],
      ] as const) {
        const sample = await sink.getSample(at);
        assert(sample, 'Missing decoded sample');
        try {
          sample!.draw(context, 0, 0);
          const [r, , b] = context.getImageData(160, 90, 1, 1).data;
          assert(
            red ? r! > 180 && b! < 70 : b! > 180 && r! < 70,
            'A frame drew before its coordinate was ready',
          );
        } finally {
          sample?.close();
        }
      }
    } finally {
      input.dispose();
    }
    assert(askedBeforeEncode >= 2, 'The next coordinate waited for the frame before to encode');
    // A coordinate failing at the first frame, or at a later one while the one before encodes.
    for (const failsAt of [0, 0.5]) {
      const broken = new WritableStream<VideoWrite>();
      await rejects(
        exportVideo(shown, {
          output: broken,
          width: 320,
          height: 180,
          duration: 1,
          frameRate: 30,
          at: async (seconds) => {
            if (seconds >= failsAt) throw new Error('samples missing');
            return seconds;
          },
        }),
        'samples missing',
      );
      assert(!broken.locked && open() === 0, 'A failed coordinate leaked writer or encoder');
    }
    return { readied: 'passed', frames: result.frames, askedBeforeEncode };
  } finally {
    shown.destroy();
  }
}
export async function check() {
  const NativeEncoder = globalThis.VideoEncoder;
  const encoders = new Set<VideoEncoder>();
  let peakQueue = 0,
    encoded: (() => void) | undefined;
  globalThis.VideoEncoder = class extends NativeEncoder {
    constructor(config: VideoEncoderInit) {
      super(config);
      encoders.add(this);
    }
    override encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions) {
      encoded?.();
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
    const top = solid(gpu, [1, 0, 0, 1], true),
      bottom = solid(gpu, [0, 1, 0, 1]);
    const composed = createComposition(gpu, {
      views: [
        { view: top, region: [0, 0, 1, 0.5] },
        { view: bottom, region: [0, 0.5, 1, 0.5] },
      ],
    });
    try {
      for (const format of ['mp4', 'webm'] as const) {
        const output = memory(),
          seen: number[] = [];
        const result = await exportVideo(composed, {
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
      report.push(
        await readied(
          gpu,
          () => encoders.size,
          (hook) => (encoded = hook),
        ),
      );
      encoded = undefined;
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
        const result = await exportVideo(composed, {
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
      const pending = exportVideo(composed, {
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
        exportVideo(composed, { output: broken, width: 320, height: 180, duration: 1 }),
        'disk full',
      );
      assert(!broken.locked && encoders.size === 0, 'Failed write leaked resources');
      await rejects(
        exportVideo(composed, {
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
      composed.destroy();
      top.destroy();
      bottom.destroy();
    }
    assert(!errors.length, errors.join('\n'));
    return report;
  } finally {
    gpu.destroy();
    globalThis.VideoEncoder = NativeEncoder;
  }
}
