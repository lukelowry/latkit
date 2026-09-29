// @vitest-environment jsdom
import { createRenderTarget } from '@latkit/gpu';
import { Series } from '@latkit/model';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Axes } from '../src/axes.js';
import { resolveOptions } from '../src/options.js';
import { createMonitorRenderer } from '../src/render.js';
import { installGpuStub, type GpuStub } from './gpu-stub.js';

let stub: GpuStub;
beforeEach(() => {
  stub = installGpuStub();
});
afterEach(() => stub.teardown());

it('sizes the gutter to visible labels and caches unchanged layout', () => {
  const target = createRenderTarget(stub.device, 800, 300);
  const options = resolveOptions({});
  const axes = new Axes(target, options, 1);
  try {
    axes.configure(options, 1, [0.8, 1.2]);
    expect(axes.rect.x).toBeGreaterThan(20);
    expect(axes.rect.x).toBeLessThan(45);
    const rect = axes.rect;
    expect(axes.configure(options, 1, [0.8, 1.2])).toBe(false);
    expect(axes.rect).toBe(rect);
    axes.configure(
      resolveOptions({ valueAxis: { ticks: [{ value: 1, label: 'Long custom label' }] } }),
      1,
      [0, 2],
    );
    expect(axes.rect.x).toBeGreaterThan(100);
    axes.configure(resolveOptions({ valueAxis: null }), 1);
    expect(axes.rect.x).toBe(0);
  } finally {
    axes.destroy();
    target.destroy();
  }
});

it('finishes axis layout during preparation and reuses history for every export frame', async () => {
  const target = createRenderTarget(stub.device, 800, 300);
  const series = Series.create({
    signals: ['x'],
    elementCount: 1,
    time: Float64Array.of(0, 1),
    values: Float64Array.of(0, 1000),
  });
  const renderer = createMonitorRenderer(target, {
    kind: 'monitor',
    series,
    signal: 0,
    options: { valueRange: [0, 1000], valueAxis: { format: 'fixed', precision: 0 } },
  });
  try {
    const signal = new AbortController().signal;
    await renderer.prepare(0, signal);
    const history = () => stub.log.textures.filter((t) => t.label === 'monitor-history');
    const before = history().slice();
    const draws = stub.log.draws.filter((d) => d.pipeline === 'monitor-history').length;
    expect(before.at(-1)!.width).toBeGreaterThan(740);
    renderer.draw(0);
    await renderer.prepare(1, signal);
    renderer.draw(1000);
    expect(history()).toEqual(before);
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-history')).toHaveLength(draws);
    expect(before.at(-1)!.destroyed).toBe(false);
  } finally {
    renderer.destroy();
    target.destroy();
  }
});
