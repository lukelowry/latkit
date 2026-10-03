import { describe, expect, it } from 'vitest';
import { settings, timeline } from '../src/timing.js';
import type { VideoOptions } from '../src/video.js';
const options = (patch: Partial<VideoOptions> = {}) =>
  ({
    output: new WritableStream(),
    width: 1280,
    height: 720,
    duration: 10,
    ...patch,
  }) as VideoOptions;
describe('video timing', () => {
  it('derives precise fractional-rate timestamps without accumulated drift', () => {
    const config = settings(options({ duration: 3600, frameRate: 30000 / 1001 }), 8192);
    expect(config.frames).toBe(107893);
    let through = 0;
    for (let i = 0; i < config.frames; i++) {
      const frame = timeline(config, i);
      expect(frame.timestamp).toBe(through);
      expect(frame.duration).toBeGreaterThan(0);
      through += frame.duration;
    }
    expect(through).toBe(3_600_000_000);
  });
  it('does not add an extra frame at exact duration boundaries', () => {
    for (const rate of [24, 30, 60, 30000 / 1001]) {
      const config = settings(options({ duration: 600 / rate, frameRate: rate }), 8192);
      expect(config.frames).toBe(600);
    }
  });
  it('rejects invalid dimensions, rates, destinations and ambiguous quality', () => {
    for (const patch of [
      { width: 0 },
      { height: 9000 },
      { frameRate: NaN },
      { duration: Infinity },
      { duration: 0 },
      { bitrate: 1000, quality: 0.75 },
      { quality: 1.5 },
    ])
      expect(() => settings(options(patch), 8192)).toThrow();
    const output = new WritableStream();
    const writer = output.getWriter();
    expect(() => settings(options({ output }), 8192)).toThrow();
    writer.releaseLock();
  });
});
