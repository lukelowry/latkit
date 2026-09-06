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
  it('decodes time as f64 and values as f32, with null gaps and base64 slots', () => {
    const time = Float64Array.from([0, 0.5]);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(time.buffer)));

    const parsed = parseSeries({
      time: { base64 },
      values: [1, null, 3, 4],
      signalCount: 1,
      elementCount: 2,
      ranges: [1, 4],
      validFrames: 1,
    });

    expect(parsed.time).toEqual(time);
    expect(parsed.values).toBeInstanceOf(Float32Array);
    expect(parsed.values[1]).toBeNaN();
    expect(parsed.ranges).toEqual(new Float32Array([1, 4]));
    expect(parsed.validFrames).toBe(1);
    expect(parseSeries(serializedSeries())).toEqual(series());
  });

  it('names the failing path', () => {
    expect(() => parseSeries([])).toThrow('root must be an object');
    expect(() => parseSeries({ time: [0] })).toThrow('root.values is required');
    expect(() => parseSeries({ time: [0], values: [1], signalCount: 1, elementCount: 2 })).toThrow(
      'values length 1 != 2',
    );
    expect(() => parseSeries({ time: [], values: [], signalCount: 1, elementCount: 1 })).toThrow(
      'time must include at least one frame',
    );
    expect(() =>
      parseSeries({ time: [0], values: ['1'], signalCount: 1, elementCount: 1 }),
    ).toThrow('values[0] must be a number or null');
    expect(() =>
      parseSeries({ time: [0], values: [1], signalCount: 1, elementCount: 1, ranges: [0] }),
    ).toThrow('ranges length 1 < 2');
    expect(() => validateSeries({ ...series(), time: [0, 1, 2] })).toThrow(
      'time must be a Float64Array',
    );
    expect(() => validateSeries({ ...series(), validFrames: -1 })).toThrow(
      'validFrames must not be negative',
    );
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
    expect(monitor.load).toHaveBeenCalledExactlyOnceWith(series(), 1);
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
