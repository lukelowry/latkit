import { failure } from '@latkit/model';
import type { VideoOptions } from './video.js';
/** Validated options; sizes are bounded by the device's texture dimension. */
export function settings(options: VideoOptions, maxDimension: number) {
  const frameRate = options.frameRate ?? 60;
  for (const [name, value] of [
    ['width', options.width],
    ['height', options.height],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > maxDimension)
      throw failure('invalid-input', `Invalid video ${name}`);
  const pixelRatio = options.pixelRatio ?? 1;
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0)
    throw failure('invalid-input', 'Video pixelRatio must be positive');
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 240)
    throw failure('invalid-input', 'Video frameRate must be between 1 and 240');
  const durationUs = Math.round(options.duration * 1e6);
  if (!Number.isSafeInteger(durationUs) || durationUs < 1)
    throw failure(
      'invalid-input',
      'Video duration must be finite, positive and representable in microseconds',
    );
  const format = options.format ?? 'mp4',
    quality = options.quality ?? 0.75;
  if (!['mp4', 'webm'].includes(format)) throw failure('invalid-input', 'Unsupported video format');
  if (!(quality >= 0 && quality <= 1))
    throw failure('invalid-input', 'Video quality must be between 0 and 1');
  if (
    options.bitrate !== undefined &&
    (!Number.isSafeInteger(options.bitrate) || options.bitrate < 1 || options.quality !== undefined)
  )
    throw failure('invalid-input', 'Specify a positive bitrate or quality, not both');
  if (!options.output || options.output.locked)
    throw failure('invalid-input', 'Video output must be an unlocked WritableStream');
  if (options.at !== undefined && typeof options.at !== 'function')
    throw failure('invalid-input', 'Video at must be a coordinate function');
  // Count frame starts strictly before the rounded end; avoid a spurious frame at float boundaries.
  let frames = Math.ceil((durationUs * frameRate) / 1e6);
  if (Math.round(((frames - 1) * 1e6) / frameRate) >= durationUs) frames--;
  return {
    width: options.width,
    height: options.height,
    pixelRatio,
    frameRate,
    frames,
    durationUs,
    format,
    quality,
    bitrate: options.bitrate,
    keyFrames: Math.max(1, Math.round(frameRate)),
  };
}
export function timeline(config: { frameRate: number; durationUs: number }, frame: number) {
  const timestamp = Math.round((frame * 1e6) / config.frameRate);
  const end = Math.min(config.durationUs, Math.round(((frame + 1) * 1e6) / config.frameRate));
  return { seconds: frame / config.frameRate, timestamp, duration: end - timestamp };
}
