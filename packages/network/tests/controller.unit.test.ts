// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetwork } from '../src/controller.js';
import type { Events, Options } from '../src/controller.js';
import {
  FLAG_DAYLIGHT,
  FLAG_FOCUS_ENABLED,
  FLAG_FOCUS_HOVER_ENDPOINTS,
  FLAG_FOCUS_SELECTED_ENDPOINTS,
  FLAG_GRATICULE,
} from '../src/webgpu/uniforms.js';
import { VISUAL } from '../src/visual.js';
import { createControllerHarness, flushMicrotasks } from './fixtures/controller-harness.js';
import { geographicTopology, nonGlobeTopology } from './fixtures/topology.js';

type Harness = Awaited<ReturnType<typeof createControllerHarness>>;

let harnesses: Harness[] = [];

async function makeHarness(options: Options = {}): Promise<Harness> {
  const harness = await createControllerHarness(options);
  harnesses.push(harness);
  return harness;
}

function expectRgbaClose(actual: Float32Array, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i]!, 6);
  }
}

afterEach(() => {
  for (const harness of harnesses) harness.destroy();
  harnesses = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createNetwork controller', () => {
  it('surfaces WebGPU setup failures through the public factory', async () => {
    const container = document.createElement('div');
    vi.stubGlobal('navigator', { gpu: undefined });

    await expect(createNetwork(container)).rejects.toThrow('WebGPU is not available');
  });

  it('applies construction options through renderer and uniforms', async () => {
    const h = await makeHarness({
      vertices: false,
      earthAxis: false,
      graticule: true,
      daylight: false,
      baseColor: [0.1, 0.2, 0.3, 1],
      colormap: (t) => [t, 0, 1 - t],
      graticuleColor: [0.2, 0.3, 0.4, 1],
      surfaceColor: [0.3, 0.4, 0.5, 1],
      borderColor: [0.4, 0.5, 0.6, 1],
    });

    expect(h.renderer.visibility).toMatchObject({
      vertices: false,
      edges: true,
      poles: false,
      borders: true,
      earthAxis: false,
    });
    expect(h.loop.uniforms.projection.flags & FLAG_GRATICULE).toBe(FLAG_GRATICULE);
    expect(h.loop.uniforms.projection.flags & FLAG_DAYLIGHT).toBe(0);
    expectRgbaClose(h.loop.uniforms.baseVertexColor, [0.1, 0.2, 0.3, 1]);
    expectRgbaClose(h.loop.uniforms.gridColor, [0.2, 0.3, 0.4, 1]);
    expectRgbaClose(h.loop.uniforms.surfaceColor, [0.3, 0.4, 0.5, 1]);
    expectRgbaClose(h.loop.uniforms.borderColor, [0.4, 0.5, 0.6, 1]);
    expect(h.renderer.writeColormap).toHaveBeenCalledOnce();
  });

  it('threads setOptions through renderer state and projection flags', async () => {
    const h = await makeHarness();

    h.network.setOptions({ vertices: false, graticule: true, earthAxis: false });

    expect(h.renderer.visibility.vertices).toBe(false);
    expect(h.renderer.visibility.earthAxis).toBe(false);
    expect(h.loop.uniforms.projection.flags & FLAG_GRATICULE).toBe(FLAG_GRATICULE);
    expect(h.loop.wake).toHaveBeenCalled();
  });

  it('threads focus options through focus uniforms', async () => {
    const h = await makeHarness();

    h.network.setOptions({
      hoverColor: [1, 0, 0, 0.5],
      selectedColor: [0, 1, 0, 0.25],
      hoverAlpha: 0.8,
      selectedAlpha: 0.6,
      vertexHoverPx: 8,
      vertexSelectedPx: 9,
      edgeHoverPx: 4,
      edgeSelectedPx: 5,
      focusEndpointMode: 'hover-selected',
    });

    expect(h.loop.uniforms.focus.hoverColor).toBe(0x0000ff);
    expect(h.loop.uniforms.focus.selectedColor).toBe(0x00ff00);
    expect(h.loop.uniforms.focus.hoverAlpha).toBeCloseTo(0.4);
    expect(h.loop.uniforms.focus.selectedAlpha).toBeCloseTo(0.15);
    expect(h.loop.uniforms.focus.vertexHoverUnderlayPx).toBe(8);
    expect(h.loop.uniforms.focus.vertexSelectedUnderlayPx).toBe(9);
    expect(h.loop.uniforms.focus.edgeHoverUnderlayPx).toBe(4);
    expect(h.loop.uniforms.focus.edgeSelectedUnderlayPx).toBe(5);
    expect(h.loop.uniforms.focus.flags & FLAG_FOCUS_ENABLED).toBe(FLAG_FOCUS_ENABLED);
    expect(h.loop.uniforms.focus.flags & FLAG_FOCUS_SELECTED_ENDPOINTS).toBe(
      FLAG_FOCUS_SELECTED_ENDPOINTS,
    );
    expect(h.loop.uniforms.focus.flags & FLAG_FOCUS_HOVER_ENDPOINTS).toBe(
      FLAG_FOCUS_HOVER_ENDPOINTS,
    );

    h.network.setOptions({ focusEnabled: false });

    expect(h.loop.uniforms.focus.flags).toBe(0);
  });

  it('loads topology into renderer and picker, updates projections, and requests first frame', async () => {
    const h = await makeHarness();

    h.network.load(geographicTopology());

    expect(h.renderer.bindTopology).toHaveBeenCalledOnce();
    expect(h.picker.setScene).toHaveBeenCalledOnce();
    expect(h.network.projections).toMatchObject({ flat: true, tilt: true, globe: true });
    expect(h.loop.setBounds).toHaveBeenCalled();
    expect(h.loop.requestFit).toHaveBeenCalled();
    expect(h.loop.frameNow).toHaveBeenCalled();
  });

  it('keeps renderer, loop, and picker callbacks wired to live controller state', async () => {
    const h = await makeHarness();
    const zooms: boolean[] = [];
    h.network.on('zoom', (atFitView) => zooms.push(atFitView));

    h.loop.deps?.onZoom?.(true);
    expect(zooms).toEqual([true]);

    h.loop.wake.mockClear();
    h.renderer.onProjectionPipelinesReady?.();
    expect(h.loop.wake).toHaveBeenCalledOnce();

    expect(h.picker.deps?.mode()).toBe('flat');
    expect(h.picker.deps?.unproject(1, 2, { w: 100, h: 80 })).toEqual([0, 0]);

    const values = new Float32Array([0, 0.5, 1]);
    h.network.load(geographicTopology());
    h.network.setChannel('vertexHeight', values);
    expect(h.picker.deps?.values('vertexHeight')).toBe(values);
  });

  it('returns its canvas element from the public facade', async () => {
    const h = await makeHarness();

    expect(h.network.element).toBe(h.surface.element);
  });

  it('keeps unsupported projection changes inert', async () => {
    const h = await makeHarness();
    h.network.load(nonGlobeTopology());

    expect(h.network.setProjection('globe')).toBe(false);
    expect(h.rig.switchTo).not.toHaveBeenCalledWith('globe', expect.anything(), expect.anything());
    expect(h.renderer.useProjectionPipelines).not.toHaveBeenCalledWith('globe');
  });

  it('switches supported projections and requests a fit when placement is deferred', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    expect(h.network.setProjection('tilt')).toBe(true);
    expect(h.rig.switchTo).toHaveBeenCalledWith('tilt', expect.anything(), { w: 100, h: 80 });
    expect(h.loop.setCamera).toHaveBeenCalledWith(h.rig.camera);
    expect(h.renderer.useProjectionPipelines).toHaveBeenCalledWith('tilt');

    h.rig.nextSwitchPlaced = false;
    expect(h.network.setProjection('flat')).toBe(true);
    expect(h.loop.requestFit).toHaveBeenCalled();
  });

  it('routes display mutators through renderer, channels, uniforms, and repaint', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.loop.wake.mockClear();

    h.network.setBorders({ vertices: new Uint8Array(0), indices: new Uint32Array(0) });
    h.network.setColormap((t) => [1 - t, t, 0.5]);
    h.network.setBaseColor([0.9, 0.8, 0.7, 1]);
    h.network.setChannel('vertexColor', new Float32Array([0, 0.5, 1]));
    h.network.setChannelRange('vertexColor', [0.2, 0.8]);
    h.network.clearChannel('vertexColor');

    expect(h.renderer.setBorders).toHaveBeenCalledOnce();
    expect(h.renderer.writeColormap).toHaveBeenCalled();
    expectRgbaClose(h.loop.uniforms.baseVertexColor, [0.9, 0.8, 0.7, 1]);
    expect(h.renderer.relayout).toHaveBeenCalled();
    expect(h.renderer.writeChannel).toHaveBeenCalledWith('vertexColor', expect.any(Float32Array));
    expect(h.loop.wake).toHaveBeenCalledTimes(6);
  });

  it('applies programmatic selection and clearing without emitting select events', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const selects: Array<['vertex' | 'edge' | null, number | null]> = [];
    h.network.on('select', (kind, index) => selects.push([kind, index]));

    h.network.select('vertex', 1);
    h.network.clearSelection();

    expect(h.loop.uniforms.focus.selectedVertex).toBe(-1);
    expect(h.loop.uniforms.focus.selectedEdge).toBe(-1);
    expect(selects).toEqual([]);
  });

  it('routes pointer hover and tap intents through picker, focus, and events', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    const hovers: Array<['vertex' | 'edge' | null, number | null]> = [];
    const selects: Array<['vertex' | 'edge' | null, number | null]> = [];
    h.network.on('hover', (kind, index) => hovers.push([kind, index]));
    h.network.on('select', (kind, index) => selects.push([kind, index]));

    h.picker.nextHit = ['vertex', 1];
    h.emitPointer({ kind: 'hover', sx: 5, sy: 6, targetPx: 10, vp: { w: 100, h: 80 } });

    h.picker.nextHits = [['edge', 0]];
    h.emitPointer({ kind: 'tap', sx: 5, sy: 6, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(hovers).toEqual([['vertex', 1]]);
    expect(selects).toEqual([['edge', 0]]);
  });

  it('routes movement pointer intents to the active camera', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    h.emitPointer({ kind: 'dragStart', sx: 1, sy: 2, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'dragMove', dx: 3, dy: 4, sx: 5, sy: 6, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'dragEnd' });
    h.emitPointer({ kind: 'pan', dx: 7, dy: 8, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'zoom', factor: 1.5, sx: 9, sy: 10, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'rotate', dxPx: 11, dyPx: 12, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'doubleTap', sx: 50, sy: 40, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(h.rig.camera.beginDrag).toHaveBeenCalledWith(1, 2, { w: 100, h: 80 });
    expect(h.rig.camera.drag).toHaveBeenCalledWith(3, 4, 5, 6, { w: 100, h: 80 });
    expect(h.rig.camera.endDrag).toHaveBeenCalled();
    expect(h.rig.camera.panBy).toHaveBeenCalledWith(7, 8, { w: 100, h: 80 });
    expect(h.rig.camera.zoomAt).toHaveBeenCalledWith(1.5, 9, 10, { w: 100, h: 80 });
    expect(h.rig.camera.rotateBy).toHaveBeenCalledWith(11, 12, { w: 100, h: 80 });
    expect(h.rig.camera.fitView).toHaveBeenCalled();
  });

  it('clears hover and selection from pointer exits and empty taps', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const hovers: Array<['vertex' | 'edge' | null, number | null]> = [];
    const selects: Array<['vertex' | 'edge' | null, number | null]> = [];
    h.network.on('hover', (kind, index) => hovers.push([kind, index]));
    h.network.on('select', (kind, index) => selects.push([kind, index]));

    h.picker.nextHit = ['vertex', 1];
    h.emitPointer({ kind: 'hover', sx: 5, sy: 6, targetPx: 10, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'hoverEnd' });
    h.picker.nextHits = [];
    h.emitPointer({ kind: 'tap', sx: 5, sy: 6, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(hovers).toEqual([
      ['vertex', 1],
      [null, null],
    ]);
    expect(selects).toEqual([[null, null]]);
  });

  it('cycles stacked tap hits after current vertex or edge selections', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const selects: Array<['vertex' | 'edge' | null, number | null]> = [];
    h.network.on('select', (kind, index) => selects.push([kind, index]));

    h.picker.nextHits = [
      ['vertex', 1],
      ['edge', 0],
      ['edge', 1],
    ];
    h.network.select('vertex', 1);
    h.emitPointer({ kind: 'tap', sx: 1, sy: 2, targetPx: 10, vp: { w: 100, h: 80 } });
    h.network.select('edge', 0);
    h.emitPointer({ kind: 'tap', sx: 1, sy: 2, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(selects).toEqual([
      ['edge', 0],
      ['edge', 1],
    ]);
  });

  it('re-picks hover on rendered frames but defers costly live picks while animating', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.picker.nextHit = ['edge', 0];
    h.emitPointer({ kind: 'hover', sx: 5, sy: 6, targetPx: 10, vp: { w: 100, h: 80 } });
    h.picker.pick.mockClear();
    h.rig.camera.isAnimating.mockReturnValue(true);
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(20);

    h.loop.frame();
    h.loop.frame();

    expect(h.picker.pick).toHaveBeenCalledTimes(1);
  });

  it('defers fadeIn until first paint', async () => {
    const h = await makeHarness();

    h.network.fadeIn(75);
    expect(h.surface.element.style.opacity).toBe('0');

    h.loop.paint();

    expect(h.surface.element.style.opacity).toBe('1');
    expect(h.surface.element.style.transition).toContain('opacity 75ms');
  });

  it('reveals immediately when fadeIn is called after first paint', async () => {
    const h = await makeHarness();

    h.loop.paint();
    h.network.fadeIn(25);

    expect(h.surface.element.style.opacity).toBe('1');
    expect(h.surface.element.style.transition).toContain('opacity 25ms');
  });

  it('fits, pans, and zooms through the public camera methods', async () => {
    const h = await makeHarness();
    h.network.fit(true);
    h.network.panBy(1, 2);
    h.network.zoomBy(2);
    expect(h.rig.camera.fitView).not.toHaveBeenCalled();
    expect(h.rig.camera.panBy).not.toHaveBeenCalled();
    expect(h.rig.camera.zoomAt).not.toHaveBeenCalled();

    h.network.load(geographicTopology());
    h.network.fit(true);
    h.network.fit(false);
    h.network.panBy(3, 4);
    h.network.zoomBy(1.25);

    expect(h.rig.camera.fitView).toHaveBeenCalled();
    expect(h.loop.requestFit).toHaveBeenCalled();
    expect(h.rig.camera.panBy).toHaveBeenCalledWith(3, 4, { w: 100, h: 80 });
    expect(h.rig.camera.zoomAt).toHaveBeenCalledWith(1.25, 50, 40, { w: 100, h: 80 });
  });

  it('keeps render-loop activity in sync with pause, resume, and page visibility', async () => {
    const h = await makeHarness();
    const hidden = vi.spyOn(document, 'hidden', 'get');

    h.network.pause();
    expect(h.loop.pause).toHaveBeenCalled();
    h.network.resume();
    expect(h.loop.resume).toHaveBeenCalled();

    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.loop.pause).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.loop.resume).toHaveBeenCalledTimes(2);
  });

  it('wakes periodically for globe daylight only while daylight is enabled', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    h.rig.mode = 'globe';
    h.loop.wake.mockClear();

    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).toHaveBeenCalledOnce();

    h.network.setOptions({ daylight: false });
    h.loop.wake.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).not.toHaveBeenCalled();
  });

  it('updates globe height scale during frame hooks', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.rig.mode = 'globe';

    h.loop.frame({ w: 200, h: 100 });

    expect(h.loop.uniforms.geometry.heightWorldScale).toBeCloseTo(VISUAL.globeHeightRadialScale, 6);
  });

  it('pauses and emits deviceLost when WebGPU is lost', async () => {
    const h = await makeHarness();
    const events: Array<Parameters<Events['deviceLost']>> = [];
    h.network.on('deviceLost', (reason, message) => events.push([reason, message]));

    h.deviceLost.resolve({ reason: 'unknown', message: 'lost for test' } as GPUDeviceLostInfo);
    await flushMicrotasks();

    expect(h.loop.pause).toHaveBeenCalled();
    expect(events).toEqual([['unknown', 'lost for test']]);
  });

  it('ignores device loss caused by explicit destruction', async () => {
    const h = await makeHarness();

    h.deviceLost.resolve({ reason: 'destroyed', message: 'normal shutdown' } as GPUDeviceLostInfo);
    await flushMicrotasks();

    expect(h.loop.pause).not.toHaveBeenCalled();
    expect(h.events.deviceLost).toEqual([]);
  });

  it('destroys owned collaborators', async () => {
    const h = await makeHarness();

    h.network.destroy();

    expect(h.loop.destroy).toHaveBeenCalled();
    expect(h.pointerCleanup.destroy).toHaveBeenCalled();
    expect(h.renderer.destroy).toHaveBeenCalled();
    expect(h.deps.destroyGpuContext).toHaveBeenCalled();
    expect(h.surface.destroy).toHaveBeenCalled();
  });
});
