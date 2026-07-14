// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMonitor, type Monitor, type Reading, type Series } from '../src/index.js';
import { SEGMENT_BUDGET, framesPerWindow } from '../src/painter.js';
import segmentWgsl from '../src/gpu/segment.wgsl?raw';
import { installGpuStub, type GpuStub } from './gpu-stub.js';

let stub: GpuStub;
beforeEach(() => {
  stub = installGpuStub();
});
afterEach(() => {
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

async function mount(options?: Parameters<typeof createMonitor>[2]): Promise<Monitor> {
  const canvas = makeCanvas();
  const monitor = await createMonitor(stub.device, canvas, options);
  mountedCanvases.set(monitor, canvas);
  return monitor;
}

const mountedCanvases = new WeakMap<Monitor, HTMLCanvasElement>();

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

function historyDraws() {
  return stub.log.draws.filter((d) => d.target === 'monitor-history');
}

function sample(series: Series, signal: number, frame: number): Float32Array {
  const start = signal * series.time.length * series.elementCount + frame * series.elementCount;
  return series.values.subarray(start, start + series.elementCount);
}

describe('monitor', () => {
  it('rejects compatibility devices before configuring the caller canvas', async () => {
    const canvas = makeCanvas();
    const device = {
      limits: { maxStorageBuffersInVertexStage: 0 },
    } as unknown as GPUDevice;

    await expect(createMonitor(device, canvas)).rejects.toThrow('A Core WebGPU device is required');
    expect(stub.log.contextConfigures).toBe(0);
    expect(canvas.isConnected).toBe(true);
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

    const monitor = await createMonitor(stub.device, canvas);

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
    const monitor = await mount();

    expect(stub.log.contextConfigurations).toEqual([
      {
        device: stub.device,
        format: 'bgra8unorm',
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      },
    ]);

    monitor.destroy();
  });

  it('observes the canvas and uses exact device-pixel content-box sizes', async () => {
    const canvas = makeCanvas(200, 100);
    const monitor = await createMonitor(stub.device, canvas);

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
    const monitor = await createMonitor(stub.device, canvas);

    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(128);
    let history = stub.log.textures.filter((texture) => texture.label === 'monitor-history');
    expect(history[0]).toMatchObject({ width: 256, height: 128 });
    monitor.load(makeSeries({ elements: 1, time: [0, 1], signals: [[0, 1]] }));
    await settle();
    let uniform = stub.log.writes.filter((write) => write.label === 'monitor-uniform').pop()!;
    let values = new Float32Array(uniform.copy!.buffer, uniform.copy!.byteOffset, 6);
    expect(Array.from(values.slice(0, 3))).toEqual([256, 128, expect.closeTo(0.48, 5)]);

    stub.resize(canvas, [600, 600]);
    await stub.frame();
    history = stub.log.textures.filter((texture) => texture.label === 'monitor-history');
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(256);
    expect(history[1]).toMatchObject({ width: 256, height: 256 });
    uniform = stub.log.writes.filter((write) => write.label === 'monitor-uniform').pop()!;
    values = new Float32Array(uniform.copy!.buffer, uniform.copy!.byteOffset, 6);
    expect(Array.from(values.slice(0, 3))).toEqual([256, 256, expect.closeTo(0.64, 5)]);

    monitor.destroy();
  });

  it('falls back to CSS pixels times DPR when device-pixel observation is unavailable', async () => {
    stub.setDevicePixelObservationAvailable(false);
    const canvas = makeCanvas(200, 100);
    const monitor = await createMonitor(stub.device, canvas);

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

    monitor.destroy();
  });

  it('shares one borrowed device without taking ownership', async () => {
    const first = await mount();
    const second = await mount();
    const firstCanvas = canvasFor(first);
    const secondCanvas = canvasFor(second);
    expect(stub.log.contextConfigures).toBe(2);
    expect(stub.log.formatQueries).toBe(2);

    first.destroy();
    first.destroy();
    expect(stub.log.contextUnconfigures).toBe(1);
    expect(stub.log.deviceDestroys).toBe(0);
    expect(firstCanvas.isConnected).toBe(true);

    second.load(makeSeries({ elements: 1, time: [0, 1], signals: [[0, 1]] }));
    await settle();
    expect(historyDraws()).not.toHaveLength(0);

    second.destroy();
    second.destroy();
    expect(stub.log.contextUnconfigures).toBe(2);
    expect(stub.log.deviceDestroys).toBe(0);
    expect(secondCanvas.isConnected).toBe(true);
  });

  it('preserves canvas context failures and leaves the borrowed device alive', async () => {
    stub.setContextAvailable(false);
    const canvas = makeCanvas();

    const creation = createMonitor(stub.device, canvas);
    await expect(creation).rejects.toThrow('WebGPU canvas context unavailable');
    expect(canvas.isConnected).toBe(true);
    expect(stub.log.deviceDestroys).toBe(0);
  });

  it('preserves preferred-format errors by identity', async () => {
    const failure = new Error('preferred format failed');
    stub.setFormatError(failure);
    const canvas = makeCanvas();

    await expect(createMonitor(stub.device, canvas)).rejects.toBe(failure);
    expect(canvas.isConnected).toBe(true);
    expect(stub.log.deviceDestroys).toBe(0);
  });

  it('unconfigures partial canvas setup and preserves configuration errors', async () => {
    const failure = new Error('canvas configuration failed');
    stub.setConfigureError(failure);
    const canvas = makeCanvas();

    await expect(createMonitor(stub.device, canvas)).rejects.toBe(failure);
    expect(canvas.isConnected).toBe(true);
    expect(canvas.getAttribute('width')).toBeNull();
    expect(canvas.getAttribute('height')).toBeNull();
    expect(stub.log.contextUnconfigures).toBe(1);
    expect(stub.log.deviceDestroys).toBe(0);
  });

  it('transactionally cleans up when caller colormap code throws', async () => {
    const failure = new Error('colormap failed');
    const canvas = makeCanvas();

    await expect(
      createMonitor(stub.device, canvas, {
        colormap: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(canvas.isConnected).toBe(true);
    expect(canvas.getAttribute('width')).toBeNull();
    expect(canvas.getAttribute('height')).toBeNull();
    expect(stub.log.contextUnconfigures).toBe(1);
    expect(stub.log.resizeDisconnects).toBe(1);
    expect(stub.log.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(stub.log.deviceDestroys).toBe(0);
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
    scope.destroy();
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
    scope.destroy();
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
    scope.destroy();
  });

  it('extend before load and malformed buffers throw', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 2, time: [0, 1], signals: [[1, 2, 3, 4]] });
    expect(() => scope.extend(1)).toThrow('before load');
    expect(() => scope.setSignal(0)).toThrow('before load');
    scope.load(series);
    expect(() => scope.extend(1, new Float32Array(1))).toThrow('values length');
    expect(() => scope.load({ ...series, signalCount: 2 })).toThrow('values length');
    scope.destroy();
  });

  it('setValueRange rescales y and color together; null returns to signal extent; auto range change on extend repaints once', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 1, time: [0, 1, 2], signals: [[1, 2, 3]] });
    scope.load(series);
    await settle();
    stub.log.clears.length = 0;

    scope.setValueRange([0, 10]);
    await settle();
    let uniform = stub.log.writes.filter((w) => w.label === 'monitor-uniform').pop()!;
    let f32 = new Float32Array(uniform.copy!.buffer, uniform.copy!.byteOffset, 6);
    expect(f32[4]).toBe(0);
    expect(f32[5]).toBeCloseTo(0.1, 6);
    expect(stub.log.clears).toContain('monitor-history');

    scope.setValueRange(null);
    uniform = stub.log.writes.filter((w) => w.label === 'monitor-uniform').pop()!;
    f32 = new Float32Array(uniform.copy!.buffer, uniform.copy!.byteOffset, 6);
    expect(f32[4]).toBe(1);
    expect(f32[5]).toBeCloseTo(1 / 2, 6);
    await settle();

    stub.log.clears.length = 0;
    const grown = makeSeries({ elements: 1, time: [0, 1, 2], signals: [[1, 2, 9]] });
    scope.extend(3, grown.values);
    await settle();
    expect(stub.log.clears.filter((t) => t === 'monitor-history')).toHaveLength(1);
    scope.destroy();
  });

  it('colormap: bakes a 256-entry LUT and repaints', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[0, 1]] });
    scope.load(series);
    await settle();
    stub.log.clears.length = 0;

    const fn = (t: number): readonly [number, number, number] => [t, 0.5, 1 - t];
    scope.setColormap(fn);
    const lut = stub.log.lutWrites.pop()!;
    expect(lut).toHaveLength(256 * 4);
    expect([lut[0], lut[1], lut[2], lut[3]]).toEqual([0, 128, 255, 255]);
    expect([lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]]).toEqual([255, 128, 0]);
    const mid = 128 / 255;
    expect(lut[128 * 4]).toBe(Math.round(Math.min(1, Math.max(0, mid)) * 255));
    await settle();
    expect(stub.log.clears).toContain('monitor-history');
    scope.destroy();
  });

  it('focus overlays one element on the canvas and never touches the history texture', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 2, time: [0, 1, 2], signals: [[1, 2, 3, 4, 5, 6]] });
    scope.load(series);
    await settle();
    const historyBefore = historyDraws().length;

    scope.setFocus(1);
    await settle();
    const focusWrites = stub.log.writes.filter((w) => w.label === 'monitor-focus-values');
    expect(focusWrites.length).toBeGreaterThan(0);
    const gathered = new Float32Array(focusWrites.pop()!.copy!.buffer);
    expect([...gathered]).toEqual([2, 4, 6]);
    const overlay = stub.log.draws.filter(
      (d) => d.target === 'canvas' && d.pipeline === 'monitor-focus',
    );
    expect(overlay.length).toBeGreaterThan(0);
    expect(overlay[0]!.instanceCount).toBe(2);
    expect(historyDraws().length).toBe(historyBefore);

    stub.log.draws.length = 0;
    scope.setFocus(null);
    await settle();
    expect(stub.log.draws.filter((d) => d.pipeline === 'monitor-focus')).toHaveLength(0);
    scope.destroy();
  });

  it('signal swap validates, reallocates slabs, repaints; old buffers destroyed', async () => {
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
    expect(before.every((b) => b.destroyed)).toBe(true);
    const after = stub.log.buffers.filter((b) => b.label === 'monitor-values');
    expect(after.length).toBe(before.length + 1);
    expect(stub.log.clears).toContain('monitor-history');
    const slab = stub.log.writes.filter((w) => w.label === 'monitor-values').pop()!;
    expect(slab.byteOffset).toBe(1 * 1 * 2 * 4);
    scope.destroy();
  });

  it('load with an out-of-range signal throws and leaves the prior view intact', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[1, 2]] });
    scope.load(series);
    await settle();
    const other = makeSeries({ elements: 1, time: [0, 1], signals: [[5, 6]] });
    expect(() => scope.load(other, 1)).toThrow('out of [0, 1)');
    expect(() => scope.extend(2)).not.toThrow();
    scope.destroy();
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
    scope.destroy();
  });

  it('framesPerWindow: 64 MiB of values, floor two frames', () => {
    expect(framesPerWindow(100)).toBe(Math.floor((64 * 1024 * 1024) / 4 / 100));
    expect(framesPerWindow(1)).toBe(16 * 1024 * 1024);
    expect(framesPerWindow(1e9)).toBe(2);
  });

  it('hover scans once per frame and pick fires the same Reading on pointerdown', async () => {
    const scope = await mount({ valueRange: [0, 10] });
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

    const hovers: (Reading | null)[] = [];
    const picks: Reading[] = [];
    scope.on('hover', (r) => hovers.push(r));
    scope.on('pick', (r) => picks.push(r));

    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 180, clientY: 49 }));
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 180, clientY: 50 }));
    await stub.frame();
    expect(hovers).toHaveLength(1);
    expect(hovers[0]).toMatchObject({ signal: 0, element: 1, frame: 0, t: 0, value: 5 });
    expect(hovers[0]!.x).toBeCloseTo(0.9, 6);

    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 180, clientY: 50 }));
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ element: 1, frame: 0, value: 5 });

    canvas.dispatchEvent(new MouseEvent('pointerleave'));
    await stub.frame();
    expect(hovers[hovers.length - 1]).toBeNull();
    scope.destroy();
  });

  it('shared device loss reaches every borrower once and still permits cleanup', async () => {
    const first = await mount();
    const second = await mount();
    const firstLost: unknown[] = [];
    const secondLost: unknown[] = [];
    first.on('deviceLost', (info) => firstLost.push(info));
    second.on('deviceLost', (info) => secondLost.push(info));
    stub.loseDevice('unknown', 'simulated');
    await stub.frame();
    await stub.frame();
    expect(firstLost).toHaveLength(1);
    expect(secondLost).toHaveLength(1);
    expect(firstLost[0]).toMatchObject({ message: 'simulated' });
    expect(secondLost[0]).toMatchObject({ message: 'simulated' });

    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[1, 2]] });
    stub.log.draws.length = 0;
    first.load(series);
    second.load(series);
    await stub.frame();
    expect(stub.log.draws).toHaveLength(0);
    first.destroy();
    second.destroy();
    expect(stub.log.contextUnconfigures).toBe(2);
    expect(stub.log.deviceDestroys).toBe(0);
  });

  it('treats owner destruction of a borrowed device as device loss', async () => {
    const scope = await mount();
    const lost: unknown[] = [];
    scope.on('deviceLost', (info) => lost.push(info));

    stub.loseDevice('destroyed', 'owner destroyed device');
    await stub.frame();

    expect(lost).toEqual([{ reason: 'destroyed', message: 'owner destroyed device' }]);
    scope.destroy();
  });

  it('clear blanks the canvas and drops the series', async () => {
    const scope = await mount();
    const series = makeSeries({ elements: 1, time: [0, 1], signals: [[1, 2]] });
    scope.load(series);
    await settle();
    stub.log.clears.length = 0;
    scope.clear();
    await settle();
    expect(stub.log.clears).toContain('monitor-history');
    expect(() => scope.extend(2)).toThrow('before load');
    scope.destroy();
  });
});
