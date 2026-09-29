import { describe, expect, it } from 'vitest';
import { Series } from '@latkit/model';
import { configure, panels, timeline } from '../src/config.js';
import { pack, unpack } from '../src/scenes.js';
import type { Options, Scene } from '../src/types.js';
const source = Series.create({ signals: ['x'], elementCount: 1 });
const monitor: Scene = { kind: 'monitor', series: source, signal: 0 };
const options: Options = { views: [monitor], timeRange: [10, 20], width: 1920, height: 1080 };
describe('export contract', () => {
  it('keeps source time and integer video timestamps distinct at fractional frame rates', () => {
    const clock = timeline({ timeRange: [10, 20], rate: 2, frameRate: 29.97 });
    expect(clock.frames).toBe(150);
    expect(clock.frame(0)).toEqual({ time: 10, timestamp: 0, duration: 33367 });
    let end = 0;
    for (let i = 0; i < clock.frames; i++) {
      const frame = clock.frame(i);
      expect(frame.timestamp).toBe(end);
      expect(frame.duration).toBeGreaterThan(0);
      expect(frame.time).toBeLessThan(20);
      end += frame.duration;
    }
    expect(end).toBe(5_000_000);
  });
  it.each([
    { width: 0 },
    { width: 101 },
    { height: Infinity },
    { views: [] },
    { frameRate: 0 },
    { rate: -1 },
    { timeRange: [1, 1] },
    { quality: NaN },
  ])('rejects invalid export settings %j before starting a worker', (patch) => {
    expect(() => configure({ ...options, ...patch } as Options)).toThrow();
  });
  it('tiles odd panel divisions without gaps or overlaps', () => {
    const result = panels({ width: 1920, height: 1080, layout: 'row' }, 7);
    expect(result[0]!.x).toBe(0);
    for (let i = 1; i < result.length; i++)
      expect(result[i]!.x).toBe(result[i - 1]!.x + result[i - 1]!.width);
    expect(result.at(-1)!.x + result.at(-1)!.width).toBe(1920);
  });
  it('deduplicates shared histories and never serializes sample stores or detaches caller arrays', () => {
    const values = new Float32Array([1]);
    const network: Scene = {
      kind: 'network',
      topology: {
        vertexCount: 1,
        vertexCoords: new Float32Array([0, 0]),
        edges: new Uint32Array(),
        polylineStart: new Uint32Array([0]),
      },
      channels: { vertexColor: { values: { series: source, signal: 0 } }, vertexSize: { values } },
    };
    const packed = pack([monitor, network]);
    expect(packed.series).toEqual([source]);
    const copied = structuredClone(packed.views);
    const restored = unpack(copied, [source]);
    expect(restored[0]).toMatchObject({ series: source });
    expect(restored[1]).toMatchObject({
      channels: { vertexColor: { values: { series: source, signal: 0 } } },
    });
    expect(values[0]).toBe(1);
  });
});
