// @vitest-environment jsdom
import type { Series } from '@latkit/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMonitor,
  type Events,
  type Monitor,
  type Options,
  type Reading,
} from '../src/index.js';
import { SEGMENT_BUDGET, framesPerWindow } from '../src/painter.js';
import segmentWgsl from '../src/gpu/segment.wgsl?raw';
import { installGpuStub, type GpuStub } from './gpu-stub.js';

let stub: GpuStub;
let monitors: Monitor[] = [];
beforeEach(() => {
  stub = installGpuStub();
});
afterEach(() => {
  for (const monitor of monitors) monitor.destroy();
  monitors = [];
  vi.restoreAllMocks();
  stub.teardown();
  document.body.replaceChildren();
});

/** Frame-major values for signals over `frames x elements`. */
function makeSeries(input: {
  elements: number;
  time: readonly number[];
  signals: readonly (readonly number[])[];
  validFrames?: number;
}): Series {
  const time = Float64Array.from(input.time);
  const signalCount = input.signals.length;
  const stride = time.length * input.elements;
  const values = new Float32Array(signalCount * stride);
  for (let signal = 0; signal < signalCount; signal++) {
    const source = input.signals[signal]!;
    if (source.length !== stride)
      throw new Error(`signal ${signal} has ${source.length} values, expected ${stride}`);
    values.set(source, signal * stride);
  }
  return {
    time,
    values,
    signalCount,
    elementCount: input.elements,
    ...(input.validFrames !== undefined ? { validFrames: input.validFrames } : {}),
  };
}

/** A controller over the stub's pool, tracked for teardown. */
function create(options: Options = {}): Monitor {
  const monitor = createMonitor({ devices: stub.pool, ...options });
  monitors.push(monitor);
  return monitor;
}

const mountedCanvases = new WeakMap<Monitor, HTMLCanvasElement>();

async function mount(options: Options = {}): Promise<Monitor> {
  const canvas = makeCanvas();
  const monitor = create(options);
  await monitor.attach(canvas);
  mountedCanvases.set(monitor, canvas);
  return monitor;
}

function makeCanvas(width = 320, height = 180): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperties(canvas, {
    clientWidth: { configurable: true, value: width, writable: true },
    clientHeight: { configurable: true, value: height, writable: true },
  });
  document.body.append(canvas);
  return canvas;
}

function canvasFor(monitor: Monitor): HTMLCanvasElement {
  return mountedCanvases.get(monitor)!;
}

/** Pump frames until the paint queue drains (no draws recorded on a pumped frame). */
async function settle(maxFrames = 20): Promise<void> {
  for (let i = 0; i < maxFrames; i++) {
    const before = stub.log.draws.length + stub.log.submits;
    await stub.frame();
    if (stub.log.draws.length + stub.log.submits === before) return;
  }
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function historyDraws() {
  return stub.log.draws.filter((d) => d.target === 'monitor-history');
}

function lastUniform(label = 'monitor-uniform'): Float32Array {
  const write = stub.log.writes.filter((w) => w.label === label).pop()!;
  return new Float32Array(write.copy!.buffer, write.copy!.byteOffset, 6);
}

function sample(series: Series, signal: number, frame: number): Float32Array {
  const start = signal * series.time.length * series.elementCount + frame * series.elementCount;
  return series.values.subarray(start, start + series.elementCount);
}

function record(monitor: Monitor) {
  const events = {
    attached: [] as boolean[],
    deviceLost: [] as Events['deviceLost'][],
    hover: [] as (Reading | null)[],
    select: [] as Reading[],
  };
  monitor.on('attached', (state) => events.attached.push(state));
  monitor.on('deviceLost', (loss) => events.deviceLost.push(loss));
  monitor.on('hover', (reading) => events.hover.push(reading));
  monitor.on('select', (reading) => events.select.push(reading));
  return events;
}

describe('monitor', () => {
  it('constructs synchronously without a device and validates options first', () => {
    const monitor = create({ valueRange: null, lineWidthPx: 2 });

    expect(monitor.attached).toBe(false);
    expect(stub.log.leaseAcquires).toBe(0);
    expect(stub.log.contextConfigures).toBe(0);
    expect(() => createMonitor({ lineWidthPx: -1 })).toThrow(RangeError);
    expect(() => createMonitor({ valueRange: [1, 0] })).toThrow(RangeError);
    expect(() => createMonitor({ valueRange: [0] as unknown as [number, number] })).toThrow(
      TypeError,
    );
    expect(() => createMonitor({ devices: {} as never })).toThrow(TypeError);
  });

  it('rejects non-Core devices and returns the lease before configuring the caller canvas', async () => {
    const canvas = makeCanvas();
    const release = vi.fn();
    const monitor = createMonitor({
      devices: {
        acquire: () =>
          Promise.resolve({
            device: { limits: { maxStorageBuffersInVertexStage: 0 } } as unknown as GPUDevice,
            release,
          }),
      },
    });
    monitors.push(monitor);

    await expect(monitor.attach(canvas)).rejects.toThrow('A Core WebGPU device is required');
    expect(release).toHaveBeenCalledOnce();
    expect(stub.log.contextConfigures).toBe(0);
    expect(canvas.isConnected).toBe(true);
    expect(monitor.attached).toBe(false);
  });

  it('borrows the caller canvas without creating, reparenting, or removing it', async () => {
    const host = document.createElement('section');
    const canvas = makeCanvas();
    canvas.setAttribute('width', '777');
    canvas.setAttribute('height', '333');
    canvas.style.cssText = 'display: block; width: 50%; height: 12rem;';
    const style = canvas.style.cssText;
    host.append(canvas);
    document.body.append(host);
    const createElement = vi.spyOn(document, 'createElement');

    const monitor = create();
    await monitor.attach(canvas);

    expect(createElement).not.toHaveBeenCalledWith('canvas');
    expect(canvas.parentElement).toBe(host);
    expect('element' in monitor).toBe(false);
    monitor.destroy();
    expect(canvas.parentElement).toBe(host);
    expect(canvas.getAttribute('width')).toBe('777');
    expect(canvas.getAttribute('height')).toBe('333');
    expect(canvas.style.cssText).toBe(style);
  });

  it('configures presentation textures for rendering and history copies', async () => {
    await mount();

    expect(stub.log.contextConfigurations).toEqual([
      {
        device: stub.device,
        format: 'bgra8unorm',
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      },
    ]);
  });

  it('observes the canvas and uses exact device-pixel content-box sizes', async () => {
    const canvas = makeCanvas(200, 100);
    const monitor = create();
    await monitor.attach(canvas);

    expect(stub.log.resizeObservations).toContainEqual({
      target: canvas,
      box: 'device-pixel-content-box',
    });
    stub.resize(canvas, [401, 203]);
    await stub.frame();
    expect(canvas.width).toBe(401);
    expect(canvas.height).toBe(203);
    const history = stub.log.textures.filter((texture) => texture.label === 'monitor-history');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ width: 200, height: 100, destroyed: true });
    expect(history[1]).toMatchObject({ width: 401, height: 203, destroyed: false });

    monitor.destroy();
    expect(history[1]!.destroyed).toBe(true);
  });

  it('allocates renderer textures from the device-limited backing size', async () => {
    stub.setTextureLimit(256);
    const canvas = makeCanvas(800, 400);
    const monitor = create();
    await monitor.attach(canvas);

    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(128);
    let history = stub.log.textures.filter((texture) => texture.label === 'monitor-history');
    expect(history[0]).toMatchObject({ width: 256, height: 128 });
    monitor.load(makeSeries({ elements: 1, time: [0, 1], signals: [[0, 1]] }));
    await settle();
    expect(Array.from(lastUniform().slice(0, 3))).toEqual([256, 128, expect.closeTo(0.48, 5)]);

    stub.resize(canvas, [600, 600]);
    await stub.frame();
    history = stub.log.textures.filter((texture) => texture.label === 'monitor-history');
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(256);
    expect(history[1]).toMatchObject({ width: 256, height: 256 });
    expect(Array.from(lastUniform().slice(0, 3))).toEqual([256, 256, expect.closeTo(0.64, 5)]);
  });

  it('falls back to CSS pixels times DPR when device-pixel observation is unavailable', async () => {
    stub.setDevicePixelObservationAvailable(false);
    const canvas = makeCanvas(200, 100);
    const monitor = create();
    await monitor.attach(canvas);

    expect(stub.log.resizeObservations).toContainEqual({ target: canvas, box: undefined });
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 211, writable: true },
      clientHeight: { configurable: true, value: 107, writable: true },
    });
    stub.resize(canvas);
    await stub.frame();
    const dpr = window.devicePixelRatio || 1;
    expect(canvas.width).toBe(Math.round(211 * dpr));
    expect(canvas.height).toBe(Math.round(107 * dpr));
  });

  it('shares one pooled device across monitors and returns every lease', async () => {
    const first = await mount();
    const second = await mount();
    const firstCanvas = canvasFor(first);
    const secondCanvas = canvasFor(second);
    expect(stub.log.leaseAcquires).toBe(2);
    expect(stub.log.contextConfigures).toBe(2);
    expect(stub.log.formatQueries).toBe(2);
    expect(stub.devices).toHaveLength(1);

    first.destroy();
    first.destroy();
    expect(stub.log.contextUnconfigures).toBe(1);
    expect(stub.log.leaseReleases).toBe(1);
    expect(stub.log.deviceDestroys).toBe(0);
    expect(firstCanvas.isConnected).toBe(true);

    second.load(makeSeries({ elements: 1, time: [0, 1], signals: [[0, 1]] }));
    await settle();
    expect(historyDraws()).not.toHaveLength(0);

    second.destroy();
    second.destroy();
    expect(stub.log.contextUnconfigures).toBe(2);
    expect(stub.log.leaseReleases).toBe(2);
    expect(stub.log.deviceDestroys).toBe(0);
    expect(secondCanvas.isConnected).toBe(true);
  });

  it('preserves canvas context failures and returns the lease', async () => {
    stub.setContextAvailable(false);
    const canvas = makeCanvas();
    const monitor = create();
    const events = record(monitor);

    await expect(monitor.attach(canvas)).rejects.toThrow('WebGPU canvas context unavailable');
    expect(canvas.isConnected).toBe(true);
    expect(stub.log.leaseReleases).toBe(1);
    expect(stub.log.deviceDestroys).toBe(0);
    expect(monitor.attached).toBe(false);
    expect(events.attached).toEqual([]);
  });

  it('preserves preferred-format errors by identity', async () => {
    const failure = new Error('preferred format failed');
    stub.setFormatError(failure);
    const canvas = makeCanvas();
    const monitor = create();

    await expect(monitor.attach(canvas)).rejects.toBe(failure);
    expect(canvas.isConnected).toBe(true);
    expect(stub.log.leaseReleases).toBe(1);
  });

  it('unconfigures partial canvas setup and preserves configuration errors', async () => {
    const failure = new Error('canvas configuration failed');
    stub.setConfigureError(failure);
    const canvas = makeCanvas();
    const monitor = create();

    await expect(monitor.attach(canvas)).rejects.toBe(failure);
    expect(canvas.isConnected).toBe(true);
    expect(canvas.getAttribute('width')).toBeNull();
    expect(canvas.getAttribute('height')).toBeNull();
    expect(stub.log.contextUnconfigures).toBe(1);
    expect(stub.log.leaseReleases).toBe(1);
  });

  it('throws from construction when the colormap throws, before any resource exists', () => {
    const failure = new Error('colormap failed');

    expect(() =>
      createMonitor({
        colormap: () => {
          throw failure;
        },
      }),
    ).toThrow(failure);

    expect(stub.log.leaseAcquires).toBe(0);
    expect(stub.log.contextConfigures).toBe(0);
  });

  it('applies a live option patch completely or not at all', async () => {
    const monitor = await mount();
    monitor.load(makeSeries({ elements: 1, time: [0, 1], signals: [[0, 1]] }));
    await settle();
    const lutWrites = stub.log.lutWrites.length;
    const uniform = Array.from(lastUniform());
    const failure = new Error('colormap failed');

    expect(() =>
      monitor.setOptions({
        lineWidthPx: 3,
        colormap: () => {
          throw failure;
        },
      }),
    ).toThrow(failure);
    expect(() => monitor.setOptions({ lineWidthPx: 3, valueRange: [2, 1] })).toThrow(RangeError);
    expect(() => monitor.setOptions({ lineWidthPx: Number.NaN })).toThrow(RangeError);
    await settle();

    expect(stub.log.lutWrites).toHaveLength(lutWrites);
    expect(Array.from(lastUniform())).toEqual(uniform);
  });

  it('retains series, signal, selection, and options while detached and replays them on attach', async () => {
    const monitor = create({ valueRange: [0, 10] });
    const events = record(monitor);
    const series = makeSeries({
      elements: 3,
      time: [0, 1],
      signals: [
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12],
      ],
    });

    monitor.load(series, 1);
    monitor.select(1);
    monitor.setOptions({ lineWidthPx: 3 });
    expect(stub.log.writes).toHaveLength(0);
    expect(stub.log.leaseAcquires).toBe(0);

    await monitor.attach(makeCanvas());
    await settle();

    expect(monitor.attached).toBe(true);
    expect(events.attached).toEqual([true]);
    const slab = stub.log.writes.find((write) => write.label === 'monitor-values')!;
    expect(slab.source).toBe(series.values.buffer);
    expect(slab.byteOffset).toBe(1 * 3 * 2 * 4);
    const focus = stub.log.writes.find((write) => write.label === 'monitor-focus-values')!;
    expect([...new Float32Array(focus.copy!.buffer)]).toEqual([8, 11]);
    expect(lastUniform()[2]).toBeCloseTo(3, 6);
    expect(lastUniform()[4]).toBe(0);
    expect(lastUniform()[5]).toBeCloseTo(0.1, 6);
    expect(historyDraws()).toHaveLength(1);
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-focus')).toHaveLength(1);
  });

  it('detaches without forgetting and replays onto a second canvas', async () => {
    const monitor = await mount();
    const events = record(monitor);
    const canvas = canvasFor(monitor);
    const series = makeSeries({ elements: 2, time: [0, 1, 2], signals: [[1, 2, 3, 4, 5, 6]] });
    monitor.load(series);
    monitor.select(0);
    await settle();

    monitor.detach();

    expect(monitor.attached).toBe(false);
    expect(events.attached).toEqual([false]);
    expect(stub.log.contextUnconfigures).toBe(1);
    expect(stub.log.leaseReleases).toBe(1);
    expect(stub.log.resizeDisconnects).toBe(1);
    expect(canvas.getAttribute('width')).toBeNull();
    expect(canvas.isConnected).toBe(true);
    expect(() => monitor.extend(3)).not.toThrow();

    stub.log.draws.length = 0;
    stub.log.writes.length = 0;
    const next = makeCanvas();
    await monitor.attach(next);
    await settle();

    expect(monitor.attached).toBe(true);
    expect(events.attached).toEqual([false, true]);
    expect(stub.log.contextConfigures).toBe(2);
    expect(historyDraws()).toHaveLength(1);
    expect(historyDraws()[0]).toMatchObject({ instanceCount: 2 * 2, firstInstance: 0 });
    const focus = stub.log.writes.find((write) => write.label === 'monitor-focus-values')!;
    expect([...new Float32Array(focus.copy!.buffer)]).toEqual([1, 3, 5]);
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-focus')).toHaveLength(1);
  });

  it('rejects an attach overtaken by a newer attach or a detach and returns its lease', async () => {
    const monitor = create();
    const first = makeCanvas();
    const second = makeCanvas();

    const overtaken = monitor.attach(first);
    const current = monitor.attach(second);

    await expect(overtaken).rejects.toMatchObject({ name: 'AbortError' });
    await current;
    expect(monitor.attached).toBe(true);
    expect(stub.log.leaseAcquires).toBe(2);
    expect(stub.log.leaseReleases).toBe(1);
    expect(stub.log.contextConfigures).toBe(1);
    expect(second.getAttribute('width')).toBe('320');
    expect(first.getAttribute('width')).toBeNull();

    const detached = monitor.attach(first);
    monitor.detach();
    await expect(detached).rejects.toMatchObject({ name: 'AbortError' });
    expect(monitor.attached).toBe(false);
    expect(stub.log.leaseReleases).toBe(3);
  });

  it('refuses to attach after destroy', async () => {
    const monitor = await mount();
    monitor.destroy();
    await expect(monitor.attach(makeCanvas())).rejects.toThrow('destroyed');
  });

  it('zero-copy: slabs are subarray views into the series buffer', async () => {
    const scope = await mount();
    const series = makeSeries({
      elements: 3,
      time: [0, 1],
      signals: [
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12],
      ],
    });
    scope.load(series, 1);
    await settle();
    const slabWrites = stub.log.writes.filter((w) => w.label === 'monitor-values');
    expect(slabWrites.length).toBeGreaterThan(0);
    expect(slabWrites[0]!.source).toBe(series.values.buffer);
    expect(slabWrites[0]!.byteOffset).toBe(1 * 3 * 2 * 4);
    expect(sample(series, 1, 0).buffer).toBe(series.values.buffer);
  });

  it('projection: a 2-frame, 3-element series paints 3 segments with the range uniform', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 3, time: [0, 1], signals: [[0, 5, 10, 0, 5, 10]] });
    scope.load(series);
    await settle();
    const draws = historyDraws();
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ vertexCount: 4, instanceCount: 3, firstInstance: 0 });

    const uniform = stub.log.writes.filter((w) => w.label === 'monitor-uniform').pop()!;
    const f32 = new Float32Array(uniform.copy!.buffer, uniform.copy!.byteOffset, 6);
    const u32 = new Uint32Array(uniform.copy!.buffer, uniform.copy!.byteOffset, 6);
    expect(u32[3]).toBe(3);
    expect(f32[4]).toBe(0);
    expect(f32[5]).toBeCloseTo(1 / 10, 6);
  });

  it('nan-gap: the shader collapses non-finite endpoints off-clip', () => {
    expect(segmentWgsl).toContain('non_finite');
    expect(segmentWgsl).toContain('0x7f800000u');
    expect(segmentWgsl).toContain('no fragments');
  });

  it('extend paints only [painted-1, validFrames) and connects the boundary', async () => {
    const scope = await mount({ valueRange: [0, 1] });
    const elements = 2;
    const frames = 6;
    const values = new Float32Array(frames * elements).fill(NaN);
    const series: Series = {
      time: Float64Array.from({ length: frames }, (_, i) => i),
      values,
      elementCount: elements,
      signalCount: 1,
      validFrames: 0,
    };
    scope.load(series);
    await settle();
    stub.log.draws.length = 0;
    stub.log.clears.length = 0;

    series.values.set([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 0);
    scope.extend(3);
    await settle();
    let draws = historyDraws();
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ firstInstance: 0, instanceCount: 2 * elements });

    stub.log.draws.length = 0;
    series.values.set([0.7, 0.8, 0.9, 1.0], 3 * elements);
    scope.extend(5);
    await settle();
    draws = historyDraws();
    expect(draws).toHaveLength(1);
    expect(draws[0]!.firstInstance).toBe(2 * elements);
    expect(draws[0]!.instanceCount).toBe(2 * elements);
    expect(stub.log.clears.filter((t) => t === 'monitor-history')).toHaveLength(0);
  });

  it('grows the auto-fit range from newly committed frames and repaints only when it moves', async () => {
    const scope = await mount();
    const series = makeSeries({
      elements: 1,
      time: [0, 1, 2, 3],
      signals: [[1, 3, 2, 9]],
      validFrames: 2,
    });
    scope.load(series);
    await settle();
    expect(lastUniform()[4]).toBe(1);
    expect(lastUniform()[5]).toBeCloseTo(1 / 2, 6);
    stub.log.clears.length = 0;

    scope.extend(3); // 2 sits inside [1, 3]: append, no repaint
    await settle();
    expect(stub.log.clears.filter((t) => t === 'monitor-history')).toHaveLength(0);
    expect(lastUniform()[4]).toBe(1);

    scope.extend(4); // 9 grows the range: one repaint
    await settle();
    expect(stub.log.clears.filter((t) => t === 'monitor-history')).toHaveLength(1);
    expect(lastUniform()[4]).toBe(1);
    expect(lastUniform()[5]).toBeCloseTo(1 / 8, 6);
  });

  it('extend before load and malformed buffers throw', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 2, time: [0, 1], signals: [[1, 2, 3, 4]] });
    expect(() => scope.extend(1)).toThrow('before load');
    expect(() => scope.setSignal(0)).toThrow('before load');
    scope.load(series);
    expect(() => scope.extend(1, new Float32Array(1))).toThrow('values length');
    expect(() => scope.load({ ...series, signalCount: 2 })).toThrow('values length');
  });

  it('valueRange rescales y and color together; null returns to the signal extent; an auto range change on extend repaints once', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 1, time: [0, 1, 2], signals: [[1, 2, 3]] });
    scope.load(series);
    await settle();
    stub.log.clears.length = 0;

    scope.setOptions({ valueRange: [0, 10] });
    await settle();
    expect(lastUniform()[4]).toBe(0);
    expect(lastUniform()[5]).toBeCloseTo(0.1, 6);
    expect(stub.log.clears).toContain('monitor-history');

    scope.setOptions({ valueRange: null });
    expect(lastUniform()[4]).toBe(1);
    expect(lastUniform()[5]).toBeCloseTo(1 / 2, 6);
    await settle();

    stub.log.clears.length = 0;
    const grown = makeSeries({ elements: 1, time: [0, 1, 2], signals: [[1, 2, 9]] });
    scope.extend(3, grown.values);
    await settle();
    expect(stub.log.clears.filter((t) => t === 'monitor-history')).toHaveLength(1);
    expect(lastUniform()[5]).toBeCloseTo(1 / 8, 6);
  });

  it('colormap: bakes a 256-entry LUT and repaints', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[0, 1]] });
    scope.load(series);
    await settle();
    stub.log.clears.length = 0;

    const fn = (t: number): readonly [number, number, number] => [t, 0.5, 1 - t];
    scope.setOptions({ colormap: fn });
    const lut = stub.log.lutWrites.pop()!;
    expect(lut).toHaveLength(256 * 4);
    expect([lut[0], lut[1], lut[2], lut[3]]).toEqual([0, 128, 255, 255]);
    expect([lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]]).toEqual([255, 128, 0]);
    const mid = 128 / 255;
    expect(lut[128 * 4]).toBe(Math.round(Math.min(1, Math.max(0, mid)) * 255));
    await settle();
    expect(stub.log.clears).toContain('monitor-history');
  });

  it('lineWidthPx is live and construction-only devices are ignored in a patch', async () => {
    const scope = await mount();
    scope.load(makeSeries({ elements: 1, time: [0, 1], signals: [[0, 1]] }));
    await settle();
    stub.log.clears.length = 0;

    scope.setOptions({ lineWidthPx: 4, devices: { acquire: () => Promise.reject(new Error()) } });
    await settle();

    expect(lastUniform()[2]).toBeCloseTo(4, 6);
    expect(lastUniform('monitor-focus-uniform')[2]).toBeCloseTo(10, 6);
    expect(stub.log.clears.filter((t) => t === 'monitor-history')).toHaveLength(1);
    expect(stub.log.leaseAcquires).toBe(1);

    stub.log.clears.length = 0;
    scope.setOptions({ lineWidthPx: 4 });
    scope.setOptions({});
    await settle();
    expect(stub.log.clears).toHaveLength(0);
  });

  it('select overlays one element, grows the trace by offset, and never touches the history texture', async () => {
    // A pinned range keeps extend on the append path; auto-fit growth would repaint instead.
    const scope = await mount({ valueRange: [0, 10] });
    const series = makeSeries({
      elements: 2,
      time: [0, 1, 2],
      signals: [[1, 2, 3, 4, 5, 6]],
      validFrames: 2,
    });
    scope.load(series);
    await settle();
    const historyBefore = historyDraws().length;

    scope.select(1);
    await settle();
    let focusWrites = stub.log.writes.filter((w) => w.label === 'monitor-focus-values');
    expect(focusWrites).toHaveLength(1);
    expect(focusWrites[0]).toMatchObject({ offset: 0, byteLength: 8 });
    expect([...new Float32Array(focusWrites[0]!.copy!.buffer)]).toEqual([2, 4]);
    const overlay = stub.log.draws.filter(
      (d) => d.target === 'canvas' && d.pipeline === 'monitor-focus',
    );
    expect(overlay.length).toBeGreaterThan(0);
    expect(overlay[0]!.instanceCount).toBe(1);
    expect(historyDraws().length).toBe(historyBefore);

    scope.extend(3);
    await settle();
    focusWrites = stub.log.writes.filter((w) => w.label === 'monitor-focus-values');
    expect(focusWrites).toHaveLength(2);
    expect(focusWrites[1]).toMatchObject({ offset: 8, byteLength: 4 });
    expect([...new Float32Array(focusWrites[1]!.copy!.buffer)]).toEqual([6]);
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-focus').pop()!.instanceCount).toBe(
      2,
    );

    stub.log.draws.length = 0;
    scope.select(null);
    await settle();
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-focus')).toHaveLength(0);

    scope.select(7);
    scope.select(-1);
    await settle();
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-focus')).toHaveLength(0);
  });

  it('switches signals without reallocating slabs and repaints from the new offset', async () => {
    const scope = await mount();
    const series = makeSeries({
      elements: 1,
      time: [0, 1],
      signals: [
        [1, 2],
        [3, 4],
      ],
    });
    scope.load(series);
    await settle();
    expect(() => scope.setSignal(2)).toThrow('out of [0, 2)');
    expect(() => scope.setSignal(-1)).toThrow('out of [0, 2)');

    const before = stub.log.buffers.filter((b) => b.label === 'monitor-values');
    stub.log.clears.length = 0;
    scope.setSignal(1);
    await settle();
    expect(stub.log.buffers.filter((b) => b.label === 'monitor-values')).toHaveLength(
      before.length,
    );
    expect(before.every((b) => !b.destroyed)).toBe(true);
    expect(stub.log.clears).toContain('monitor-history');
    const slab = stub.log.writes.filter((w) => w.label === 'monitor-values').pop()!;
    expect(slab.byteOffset).toBe(1 * 1 * 2 * 4);
    expect(lastUniform()[4]).toBe(3);
  });

  it('load with an out-of-range signal throws and leaves the prior view intact', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[1, 2]] });
    scope.load(series);
    await settle();
    const other = makeSeries({ elements: 1, time: [0, 1], signals: [[5, 6]] });
    expect(() => scope.load(other, 1)).toThrow('out of [0, 1)');
    expect(() => scope.extend(2)).not.toThrow();
  });

  it('chunked: no single frame submits more than SEGMENT_BUDGET instances', async () => {
    const scope = await mount({ valueRange: [0, 1] });
    const elements = 100;
    const frames = 70_001;
    const series: Series = {
      time: Float64Array.from({ length: frames }, (_, i) => i),
      values: new Float32Array(frames * elements),
      elementCount: elements,
      signalCount: 1,
    };
    scope.load(series);

    let total = 0;
    const perFrame: number[] = [];
    for (let i = 0; i < 10 && total < (frames - 1) * elements; i++) {
      const before = stub.log.draws.length;
      await stub.frame();
      const submitted = historyDraws()
        .slice(before)
        .reduce((n, d) => n + d.instanceCount, 0);
      if (submitted > 0) perFrame.push(submitted);
      total += submitted;
    }
    expect(total).toBe((frames - 1) * elements);
    expect(perFrame.length).toBeGreaterThan(1);
    for (const submitted of perFrame) expect(submitted).toBeLessThanOrEqual(SEGMENT_BUDGET);
  });

  it('framesPerWindow: 64 MiB of values, floor two frames', () => {
    expect(framesPerWindow(100)).toBe(Math.floor((64 * 1024 * 1024) / 4 / 100));
    expect(framesPerWindow(1)).toBe(16 * 1024 * 1024);
    expect(framesPerWindow(1e9)).toBe(2);
  });

  it('hover scans once per frame; pointer-down selects the reading and emits select', async () => {
    const scope = await mount({ valueRange: [0, 10] });
    const events = record(scope);
    const series = makeSeries({
      elements: 3,
      time: [0, 1],
      signals: [[0, 5, 10, 0, 5, 10]],
    });
    scope.load(series);
    await settle();

    const canvas = canvasFor(scope);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 180, clientY: 49 }));
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 180, clientY: 50 }));
    await stub.frame();
    expect(events.hover).toHaveLength(1);
    expect(events.hover[0]).toMatchObject({ signal: 0, element: 1, frame: 0, t: 0, value: 5 });
    expect(events.hover[0]!.x).toBeCloseTo(0.9, 6);

    stub.log.draws.length = 0;
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 180, clientY: 50 }));
    expect(events.select).toHaveLength(1);
    expect(events.select[0]).toMatchObject({ element: 1, frame: 0, value: 5 });
    await settle();
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-focus')).toHaveLength(1);

    canvas.dispatchEvent(new MouseEvent('pointerleave'));
    await stub.frame();
    expect(events.hover[events.hover.length - 1]).toBeNull();

    scope.detach();
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 180, clientY: 50 }));
    await stub.frame();
    expect(events.hover).toHaveLength(2);
  });

  it('recovers from device loss on a replacement device and says so, once per monitor', async () => {
    const first = await mount();
    const second = await mount();
    const firstEvents = record(first);
    const secondEvents = record(second);
    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[1, 2]] });
    first.load(series);
    second.load(series);
    await settle();
    stub.log.draws.length = 0;

    stub.loseDevice('unknown', 'simulated');
    await flush();
    await settle();

    const loss = { reason: 'unknown', message: 'simulated', recovering: true };
    expect(firstEvents.deviceLost).toEqual([loss]);
    expect(secondEvents.deviceLost).toEqual([loss]);
    expect(firstEvents.attached).toEqual([false, true]);
    expect(secondEvents.attached).toEqual([false, true]);
    expect(stub.devices).toHaveLength(2);
    expect(stub.log.leaseReleases).toBe(2);
    expect(stub.log.contextUnconfigures).toBe(2);
    expect(stub.log.contextConfigures).toBe(4);
    expect(stub.log.contextConfigurations.slice(2).map((c) => c.device)).toEqual([
      stub.devices[1],
      stub.devices[1],
    ]);
    expect(first.attached).toBe(true);
    expect(second.attached).toBe(true);
    expect(historyDraws()).toHaveLength(2);
    expect(stub.log.deviceDestroys).toBe(0);
  });

  it('reports a recovery that cannot lease a replacement and stays detached', async () => {
    const scope = await mount();
    const events = record(scope);
    stub.failAcquire(new Error('No Core WebGPU adapter is available'));

    stub.loseDevice('destroyed', 'owner destroyed device');
    await flush();

    expect(events.deviceLost).toEqual([
      { reason: 'destroyed', message: 'owner destroyed device', recovering: true },
      { reason: 'unavailable', message: 'No Core WebGPU adapter is available', recovering: false },
    ]);
    expect(events.attached).toEqual([false]);
    expect(scope.attached).toBe(false);
    expect(stub.log.leaseReleases).toBe(1);
  });

  it('ignores device loss after detach or destroy', async () => {
    const first = await mount();
    const second = await mount();
    const firstEvents = record(first);
    const secondEvents = record(second);
    first.detach();
    second.destroy();

    stub.loseDevice('unknown', 'late loss');
    await flush();

    expect(firstEvents.deviceLost).toEqual([]);
    expect(secondEvents.deviceLost).toEqual([]);
    expect(stub.log.leaseAcquires).toBe(2);
  });

  it('clear blanks the canvas, drops the series, and releases the slabs', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[1, 2]] });
    scope.load(series);
    scope.select(0);
    await settle();
    stub.log.clears.length = 0;
    stub.log.draws.length = 0;

    scope.clear();
    await settle();

    expect(stub.log.clears).toContain('monitor-history');
    expect(
      stub.log.buffers.filter((b) => b.label === 'monitor-values').every((b) => b.destroyed),
    ).toBe(true);
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-focus')).toHaveLength(0);
    expect(() => scope.extend(2)).toThrow('before load');
  });

  it('pause holds painting and hover until resume, across a detach', async () => {
    const scope = await mount();
    const events = record(scope);
    const canvas = canvasFor(scope);
    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[1, 2]] });

    scope.pause();
    scope.load(series);
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
    await settle();
    expect(historyDraws()).toHaveLength(0);
    expect(events.hover).toEqual([]);

    scope.resume();
    await settle();
    expect(historyDraws()).toHaveLength(1);

    scope.pause();
    scope.detach();
    stub.log.draws.length = 0;
    await scope.attach(makeCanvas());
    await settle();
    expect(historyDraws()).toHaveLength(0);
    scope.resume();
    await settle();
    expect(historyDraws()).toHaveLength(1);
  });
});
