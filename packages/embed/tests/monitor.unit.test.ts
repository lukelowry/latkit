// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MonitorElement } from '../src/monitor.js';
import { parseSeries, validateSeries } from '../src/monitor.js';
import {
  canvasOf,
  flushMicrotasks,
  harness,
  inline,
  patchesOf,
  series,
  serializedSeries,
  type FakeMonitor,
} from './fixtures.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function live(h: ReturnType<typeof harness>, element: HTMLElement): Promise<FakeMonitor> {
  document.body.append(element);
  h.near(element, true);
  await (element as MonitorElement).ready;
  await flushMicrotasks();
  return h.monitors[0]!;
}

describe('parseSeries', () => {
  it('decodes f64 samples and null gaps with exact time and base64 slots', async () => {
    const time = Float64Array.from([0, 0.5]);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(time.buffer)));
    const parsed = parseSeries({
      time: { base64 },
      values: [1e12, null, 1e12 + 0.125, 1e12 + 0.25],
      signalCount: 1,
      elementCount: 2,
    });
    const block = await parsed.read(0, {
      frameOffset: 0,
      frameCount: 2,
      elementOffset: 0,
      elementCount: 2,
    });
    expect(block.time).toEqual(time);
    expect(block.values).toBeInstanceOf(Float64Array);
    expect(block.values[1]).toBeNaN();
    expect(block.values[2]).toBe(1e12 + 0.125);
    expect(parsed.state.ranges).toEqual(Float64Array.of(1e12, 1e12 + 0.25));
  });
  it('validates decoded series and names malformed input', () => {
    expect(() => parseSeries([])).toThrow('root must be an object');
    expect(() => parseSeries({ time: [0] })).toThrow('root.values is required');
    expect(() => parseSeries({ time: [0], values: [1], signalCount: 1, elementCount: 2 })).toThrow(
      '1 values for 1 frames',
    );
    expect(
      parseSeries({ time: [], values: [], signalCount: 1, elementCount: 1 }).state.frameCount,
    ).toBe(0);
    expect(() =>
      parseSeries({ time: [0], values: ['1'], signalCount: 1, elementCount: 1 }),
    ).toThrow('values[0] must be a number or null');
    expect(() => validateSeries({ ...series(), read: null })).toThrow(
      'series.read must be a function',
    );
    expect(() => validateSeries({ ...series(), state: { frameCount: -1 } })).toThrow('frameCount');
  });
});

describe('latkit-monitor', () => {
  it('loads an inline series with the signal attribute and attaches near the viewport', async () => {
    const h = harness();
    const element = h.monitor() as MonitorElement;
    element.setAttribute('signal', '1');
    element.setAttribute('line-width-px', '2.5');
    element.setAttribute('value-range', '0 12');
    element.setAttribute('colormap', 'magma');
    inline(element, serializedSeries());

    const monitor = await live(h, element);

    expect(canvasOf(element).getAttribute('role')).toBe('img');
    expect(monitor.load).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ elementCount: 2, signalCount: 2 }),
      1,
    );
    expect(monitor.attach).toHaveBeenCalledExactlyOnceWith(canvasOf(element));
    const patches = patchesOf(monitor.setOptions);
    expect(patches).toMatchObject({ lineWidthPx: 2.5, valueRange: [0, 12] });
    expect(patches.colormap).toBeTypeOf('function');
    expect(element.monitor).toBe(monitor.value);
    expect(element.state).toBe('ready');
    expect(element.hasAttribute('attached')).toBe(true);
  });

  it('applies live attribute changes and warns about invalid ones', async () => {
    const h = harness();
    const element = h.monitor() as MonitorElement;
    element.setAttribute('line-width-px', '3');
    element.data = series();
    const monitor = await live(h, element);
    monitor.setOptions.mockClear();

    element.setAttribute('signal', '1');
    element.setAttribute('value-range', 'auto');
    element.removeAttribute('line-width-px');
    await flushMicrotasks();

    expect(monitor.setSignal).toHaveBeenCalledWith(1);
    expect(monitor.setOptions).toHaveBeenCalledWith({ valueRange: null });
    expect(monitor.setOptions).toHaveBeenCalledWith({ lineWidthPx: 1.5 });
    expect(h.deps.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid value-range "auto"'));

    element.setAttribute('signal', '7');
    await flushMicrotasks();
    expect(monitor.setSignal).toHaveBeenLastCalledWith(0);
    expect(h.deps.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid signal "7"'));
  });

  it('forwards controller events and detaches on disconnect', async () => {
    const h = harness();
    const element = h.monitor() as MonitorElement;
    element.data = series();
    const seen: Array<[string, unknown]> = [];
    element.addEventListener('hover', (event) => seen.push(['hover', event.detail]));
    element.addEventListener('select', (event) => seen.push(['select', event.detail]));
    const monitor = await live(h, element);

    const reading = { signal: 0, element: 1, frame: 0, t: 0, value: 2, x: 0.1, y: 0.2 };
    monitor.emit('hover', reading);
    monitor.emit('select', reading);
    monitor.emit('hover', null);
    expect(seen).toEqual([
      ['hover', reading],
      ['select', reading],
      ['hover', null],
    ]);

    element.remove();
    expect(monitor.detach).toHaveBeenCalledOnce();
    expect(element.hasAttribute('attached')).toBe(false);
  });
});
