import { GpuError } from '@latkit/gpu';
import type { VideoOptions } from './video.js';
export function settings(options: VideoOptions) {
  const frameRate = options.frameRate ?? 60;
  for (const [name, value] of [
    ['width', options.width],
    ['height', options.height],
  ] as const)
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > options.gpu.device.limits.maxTextureDimension2D
    )
      throw new GpuError('invalid-input', `Invalid video ${name}`);
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 240)
    throw new GpuError('invalid-input', 'Video frameRate must be between 1 and 240');
  const durationUs = Math.round(options.duration * 1e6);
  if (!Number.isSafeInteger(durationUs) || durationUs < 1)
    throw new GpuError(
      'invalid-input',
      'Video duration must be finite, positive and representable in microseconds',
    );
  const format = options.format ?? 'mp4',
    quality = options.quality ?? 'high';
  if (!['mp4', 'webm'].includes(format))
    throw new GpuError('invalid-input', 'Unsupported video format');
  if (!['medium', 'high', 'very-high'].includes(quality))
    throw new GpuError('invalid-input', 'Invalid video quality');
  if (
    options.bitrate !== undefined &&
    (!Number.isSafeInteger(options.bitrate) || options.bitrate < 1 || options.quality !== undefined)
  )
    throw new GpuError('invalid-input', 'Specify a positive bitrate or quality, not both');
  if (!options.output || options.output.locked)
    throw new GpuError('invalid-input', 'Video output must be an unlocked WritableStream');
  if (options.at !== undefined && typeof options.at !== 'function')
    throw new GpuError('invalid-input', 'Video at must be a coordinate function');
  // Count frame starts strictly before the rounded end; avoid a spurious frame at float boundaries.
  let frames = Math.ceil((durationUs * frameRate) / 1e6);
  if (Math.round(((frames - 1) * 1e6) / frameRate) >= durationUs) frames--;
  return {
    width: options.width,
    height: options.height,
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
