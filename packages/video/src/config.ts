import type { Options } from './types.js';
export type Config = Required<
  Pick<
    Options,
    | 'timeRange'
    | 'width'
    | 'height'
    | 'frameRate'
    | 'rate'
    | 'layout'
    | 'background'
    | 'format'
    | 'quality'
  >
>;
export function configure(options: Options): Config {
  const config: Config = {
    timeRange: options.timeRange,
    width: options.width,
    height: options.height,
    frameRate: options.frameRate ?? 30,
    rate: options.rate ?? 1,
    layout: options.layout ?? 'column',
    background: options.background ?? [0.035, 0.045, 0.065],
    format: options.format ?? 'mp4',
    quality: options.quality ?? 'high',
  };
  for (const size of [config.width, config.height]) {
    if (!Number.isSafeInteger(size) || size < 2 || size % 2)
      throw new RangeError('Video dimensions must be positive even integers');
  }
  if (!options.views.length) throw new RangeError('Video needs at least one view');
  if (!['row', 'column'].includes(config.layout)) throw new TypeError('Unknown video layout');
  if (options.views.length > (config.layout === 'row' ? config.width : config.height))
    throw new RangeError('Too many panels for this video size');
  if (!['mp4', 'webm'].includes(config.format)) throw new TypeError('Unknown video format');
  if (!Number.isFinite(config.frameRate) || config.frameRate <= 0 || config.frameRate > 240)
    throw new RangeError('frameRate must be in (0, 240]');
  if (!Number.isFinite(config.rate) || config.rate <= 0)
    throw new RangeError('rate must be positive');
  if (
    config.timeRange.length !== 2 ||
    !config.timeRange.every(Number.isFinite) ||
    config.timeRange[1] <= config.timeRange[0]
  )
    throw new RangeError('timeRange must be finite and increasing');
  if (
    config.background.length !== 3 ||
    !config.background.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  )
    throw new RangeError('background must contain three values in [0, 1]');
  if (
    typeof config.quality === 'number'
      ? !Number.isFinite(config.quality) || config.quality <= 0
      : !['medium', 'high', 'very-high'].includes(config.quality)
  )
    throw new RangeError('Invalid video quality');
  timeline(config);
  return config;
}
/** Integer microseconds prevent cumulative timestamp drift. The final frame ends at the requested duration. */
export function timeline(config: Pick<Config, 'timeRange' | 'rate' | 'frameRate'>) {
  const duration = Math.round(((config.timeRange[1] - config.timeRange[0]) / config.rate) * 1e6);
  let frames = Math.max(1, Math.ceil((duration * config.frameRate) / 1e6));
  if (!Number.isSafeInteger(duration) || duration < 1 || !Number.isSafeInteger(frames))
    throw new RangeError('Video duration is outside the supported range');
  // Rounding a nominal frame start up to the endpoint must not create an empty frame.
  if (frames > 1 && Math.round(((frames - 1) * 1e6) / config.frameRate) >= duration) frames--;
  return {
    frames,
    duration,
    frame(index: number) {
      const timestamp = Math.round((index * 1e6) / config.frameRate);
      const end = Math.min(duration, Math.round(((index + 1) * 1e6) / config.frameRate));
      return {
        timestamp,
        duration: end - timestamp,
        time: config.timeRange[0] + (timestamp / 1e6) * config.rate,
      };
    },
  };
}
export function panels(config: Pick<Config, 'width' | 'height' | 'layout'>, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const horizontal = config.layout === 'row';
    const extent = horizontal ? config.width : config.height;
    const start = Math.floor((i * extent) / count),
      end = Math.floor(((i + 1) * extent) / count);
    return {
      x: horizontal ? start : 0,
      y: horizontal ? 0 : start,
      width: horizontal ? end - start : config.width,
      height: horizontal ? config.height : end - start,
    };
  });
}
