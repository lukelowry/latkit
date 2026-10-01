import { describe, expect, it } from 'vitest';
import { Series } from '@latkit/model';
import { createDiagram } from '../src/index.js';
describe('diagram snapshots', () => {
  it('owns static structure and values while borrowing series', () => {
    const view = createDiagram();
    expect(() => view.snapshot()).toThrow();
    const structure = {
      blockCount: 2,
      portStart: new Uint32Array([0, 1, 2]),
      portFlow: new Uint8Array([1, 0]),
      netStart: new Uint32Array([0, 2]),
      netPorts: new Uint32Array([0, 1]),
      blockTitle: ['source', 'sink'],
    };
    view.load(structure);
    view.setChannel('blockColor', new Float32Array([0.2, 0.8]), [0, 1]);
    const first = view.snapshot();
    const binding = first.channels!.blockColor!;
    expect('series' in binding.values).toBe(false);
    if (!('series' in binding.values)) binding.values.fill(0);
    const second = view.snapshot().channels!.blockColor!.values;
    expect('series' in second ? [] : [...second]).toEqual([
      expect.closeTo(0.2),
      expect.closeTo(0.8),
    ]);
    const series = Series.create({ signals: ['x'], elementCount: 2 });
    view.setChannel('blockColor', { series, signal: 0 });
    expect(view.snapshot().channels!.blockColor!.values).toEqual({ series, signal: 0 });
    expect(first.options).not.toHaveProperty('devices');
    expect(first.options).not.toHaveProperty('colormap');
    expect(() => structuredClone(first)).not.toThrow();
    view.destroy();
  });
});
