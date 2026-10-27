/**
 * The H.264 encoder for latkit's videos in a browser, built on WebCodecs. It takes NV12 pictures
 * (BT.709, limited range) and returns Annex B units in order, each `[time, key, bytes]`, with
 * `time` in 90 kHz ticks. It prefers hardware encoding and uses the lowest H.264 level that fits
 * the size and frame rate.
 */

import { thrown, type LatkitError } from './internal.js';

type Unit = [time: number, key: boolean, bytes: Uint8Array];

/** H.264 levels as `[codec byte, max macroblocks per second, max macroblocks per frame]`. */
const LEVELS: readonly [level: number, perSecond: number, perFrame: number][] = [
  [0x1f, 108_000, 3_600],
  [0x28, 245_760, 8_192],
  [0x2a, 522_240, 8_704],
  [0x32, 589_824, 22_080],
  [0x33, 983_040, 36_864],
  [0x34, 2_073_600, 36_864],
  [0x3c, 4_177_920, 139_264],
  [0x3d, 8_355_840, 139_264],
  [0x3e, 16_711_680, 139_264],
];

/**
 * Constrained Baseline only. It has no B-frames, so decode and presentation times are equal, as
 * the MP4 writer assumes.
 */
const PROFILES = ['42e0'];

/**
 * The encoder configurations to try for `width`×`height` at `fps`, hardware first. The level is
 * the lowest that fits, or 6.2 when none does.
 */
function configurations(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): VideoEncoderConfig[] {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = LEVELS.find(
    ([, second, frame]) => macroblocks <= frame && macroblocks * fps <= second,
  );
  const hex = (level?.[0] ?? 0x3e).toString(16).padStart(2, '0');
  return PROFILES.flatMap((profile) =>
    (['prefer-hardware', 'no-preference'] as const).map((hardwareAcceleration) => ({
      codec: `avc1.${profile}${hex}`,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration,
      bitrateMode: 'variable' as const,
      latencyMode: 'quality' as const,
      avc: { format: 'annexb' as const },
    })),
  );
}

/**
 * Creates an encoder for `width`×`height` pictures at `fps` frames per second and `bitrate` bits
 * per second. Throws an `unsupported` error when the browser has no `VideoEncoder`. Its methods
 * reject with an `unsupported` error when the browser cannot encode H.264 at that size and rate,
 * and with an `io` error when encoding fails.
 */
export function encoder(width: number, height: number, fps: number, bitrate: number) {
  if (typeof VideoEncoder !== 'function')
    throw thrown({ code: 'unsupported', message: 'this browser has no WebCodecs VideoEncoder' });
  const units: Unit[] = [];
  const times: { timestamp: number; time: number }[] = [];
  let failure: LatkitError | undefined;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const video = new VideoEncoder({
    output(chunk) {
      const expected = times.shift();
      if (!expected || chunk.timestamp !== expected.timestamp) {
        failure = thrown({ code: 'io', message: 'the encoder reordered or omitted a frame' });
        close();
        return;
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      units.push([expected.time, chunk.type === 'key', bytes]);
    },
    error(error) {
      failure = thrown({ code: 'io', message: 'the video encoder failed', cause: error });
      wake();
    },
  });
  video.addEventListener('dequeue', wake);
  function close() {
    if (video.state !== 'closed') video.close();
    video.removeEventListener('dequeue', wake);
    wake();
  }
  let configured: Promise<void> | undefined;
  const configure = async () => {
    for (const config of configurations(width, height, fps, bitrate)) {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return video.configure(config);
    }
    throw thrown({
      code: 'unsupported',
      message: `this browser cannot encode H.264 at ${width}×${height}, ${fps} frames a second`,
    });
  };
  const failed = () => {
    if (failure) throw failure;
    if (video.state === 'closed') throw thrown({ code: 'io', message: 'the video encoder closed' });
  };
  return {
    async encode(nv12: Uint8Array, time: number, key: boolean): Promise<Unit[]> {
      await (configured ??= configure());
      failed();
      const timestamp = Math.round((time * 100) / 9);
      times.push({ timestamp, time });
      const frame = new VideoFrame(nv12, {
        format: 'NV12',
        codedWidth: width,
        codedHeight: height,
        timestamp,
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
      });
      try {
        video.encode(frame, { keyFrame: key });
      } finally {
        frame.close();
      }
      // Backpressure: wait while more than two frames are queued in the encoder.
      while (video.encodeQueueSize > 2) {
        await new Promise<void>((resolve) => waiters.add(resolve));
        failed();
      }
      failed();
      return units.splice(0);
    },
    async finish(): Promise<Unit[]> {
      try {
        await (configured ??= configure());
        failed();
        await video.flush();
        failed();
        if (times.length) throw thrown({ code: 'io', message: 'the encoder omitted a frame' });
        return units.splice(0);
      } finally {
        close();
      }
    },
    close,
  };
}
