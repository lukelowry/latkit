/**
 * The browser's H.264 encoder, as latkit's video asks for one: NV12 pictures (BT.709, limited range)
 * in, Annex B units out, each `[time, key, bytes]` in order. WebCodecs encodes, on the GPU's video
 * engine where the device has one; the level is the least that holds the size and frame rate.
 */

type Unit = [time: number, key: boolean, bytes: Uint8Array];

/** H.264 levels by the macroblocks a second and a frame they hold, as their codec byte. */
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

/** Profiles to try, best first: High, Main, Constrained Baseline. */
const PROFILES = ['6400', '4d00', '42e0'];

/** The codec configurations to try for `width`×`height` at `fps`, best first. */
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

/** An encoder for `width`×`height` pictures at `fps` and `bitrate` bits a second. */
export function encoder(width: number, height: number, fps: number, bitrate: number) {
  if (typeof VideoEncoder !== 'function')
    throw new Error('this browser has no WebCodecs VideoEncoder');
  const units: Unit[] = [];
  // Units come out in the order pictures went in, with no B-frames, so each takes the next time.
  const times: number[] = [];
  let failure: unknown;
  const video = new VideoEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      units.push([times.shift() ?? 0, chunk.type === 'key', bytes]);
    },
    error(error) {
      failure = error;
    },
  });
  let configured: Promise<void> | undefined;
  const configure = async () => {
    for (const config of configurations(width, height, fps, bitrate)) {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return video.configure(config);
    }
    throw new Error(`this browser encodes no H.264 at ${width}×${height}, ${fps} frames a second`);
  };
  const failed = () => {
    if (failure)
      throw failure instanceof Error
        ? failure
        : new Error('the video encoder failed', { cause: failure });
  };
  return {
    async encode(nv12: Uint8Array, time: number, key: boolean): Promise<Unit[]> {
      await (configured ??= configure());
      failed();
      times.push(time);
      const frame = new VideoFrame(nv12, {
        format: 'NV12',
        codedWidth: width,
        codedHeight: height,
        timestamp: Math.round((time * 100) / 9),
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
      });
      try {
        video.encode(frame, { keyFrame: key });
      } finally {
        frame.close();
      }
      // The encoder sets the pace: a frame waits while two others are still being encoded.
      while (video.encodeQueueSize > 2) {
        await new Promise((resolve) => video.addEventListener('dequeue', resolve, { once: true }));
      }
      failed();
      return units.splice(0);
    },
    async finish(): Promise<Unit[]> {
      await (configured ??= configure());
      await video.flush();
      video.close();
      failed();
      return units.splice(0);
    },
  };
}
