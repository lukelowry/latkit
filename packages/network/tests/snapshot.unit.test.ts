import { describe, expect, it } from 'vitest';
import { Series } from '@latkit/model';
import { createNetwork } from '../src/index.js';
describe('network snapshots', () => {
  it('owns static structure and values while borrowing series', () => {
    const view = createNetwork();
    expect(() => view.snapshot()).toThrow();
    const structure = {
      vertexCount: 2,
      vertexCoords: new Float32Array([0, 0, 1, 1]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 0]),
    };
    view.load(structure);
    view.setOptions({ vertices: false });
    view.setOptions({ vertices: undefined });
    expect(view.snapshot().options?.vertices).toBe(false);
    view.setChannel('vertexColor', new Float32Array([0.2, 0.8]), [0, 1]);
    const first = view.snapshot();
    const binding = first.channels!.vertexColor!;
    expect('series' in binding.values).toBe(false);
    if (!('series' in binding.values)) binding.values.fill(0);
    const second = view.snapshot().channels!.vertexColor!.values;
    expect('series' in second ? [] : [...second]).toEqual([
      expect.closeTo(0.2),
      expect.closeTo(0.8),
    ]);
    const series = Series.create({ signals: ['x'], elementCount: 2 });
    view.setChannel('vertexColor', { series, signal: 0 });
    expect(view.snapshot().channels!.vertexColor!.values).toEqual({ series, signal: 0 });
    expect(first.options).not.toHaveProperty('devices');
    expect(first.options).not.toHaveProperty('colormap');
    expect(() => structuredClone(first)).not.toThrow();
    view.destroy();
  });
});
