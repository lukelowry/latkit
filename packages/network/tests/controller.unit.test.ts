// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetwork } from '../src/controller.js';
import type { ControllerDeps, Events, Options } from '../src/controller.js';
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
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createNetwork controller', () => {
  it('rejects non-Core devices before creating a surface', async () => {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('width', '640');
    canvas.setAttribute('height', '360');
    document.body.append(canvas);
    const device = {
      limits: { maxStorageBuffersInVertexStage: 0 },
    } as unknown as GPUDevice;

    await expect(createNetwork(device, canvas)).rejects.toThrow('A Core WebGPU device is required');
    expect(canvas.isConnected).toBe(true);
  });

  it('surfaces canvas setup failures without removing or mutating the borrowed canvas', async () => {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('width', '640');
    canvas.setAttribute('height', '360');
    canvas.style.touchAction = 'pan-x';
    canvas.style.userSelect = 'text';
    canvas.style.opacity = '0.5';
    canvas.setAttribute('aria-hidden', 'false');
    document.body.append(canvas);
    const deviceDestroy = vi.fn();
    const device = {
      limits: {},
      destroy: deviceDestroy,
    } as unknown as GPUDevice;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    await expect(createNetwork(device, canvas)).rejects.toThrow(
      'WebGPU canvas context unavailable',
    );

    expect(canvas.isConnected).toBe(true);
    expect(canvas.style.touchAction).toBe('pan-x');
    expect(canvas.style.userSelect).toBe('text');
    expect(canvas.style.opacity).toBe('0.5');
    expect(canvas.getAttribute('aria-hidden')).toBe('false');
    expect(canvas.getAttribute('width')).toBe('640');
    expect(canvas.getAttribute('height')).toBe('360');
    expect(deviceDestroy).not.toHaveBeenCalled();
  });

  it('cleans partial initialization and preserves the original error', async () => {
    const failure = new Error('pointer setup failed');
    let deps!: ControllerDeps;

    await expect(
      createControllerHarness({}, (next) => {
        deps = next;
        const RenderLoop = deps.RenderLoop;
        deps.RenderLoop = vi.fn(
          (renderLoopDeps: ConstructorParameters<ControllerDeps['RenderLoop']>[0]) => {
            renderLoopDeps.presentation.resize(800, 450);
            return new RenderLoop(renderLoopDeps);
          },
        ) as unknown as typeof RenderLoop;
        deps.attachPointer = vi.fn(() => {
          throw failure;
        });
      }),
    ).rejects.toBe(failure);

    const surface = vi.mocked(deps.createSurface).mock.results[0]!.value as ReturnType<
      ControllerDeps['createSurface']
    >;
    const presentation = vi.mocked(deps.createPresentation).mock.results[0]!.value as ReturnType<
      ControllerDeps['createPresentation']
    >;
    const renderer = vi.mocked(deps.Renderer).mock.results[0]!.value as InstanceType<
      ControllerDeps['Renderer']
    >;
    const loop = vi.mocked(deps.RenderLoop).mock.results[0]!.value as InstanceType<
      ControllerDeps['RenderLoop']
    >;

    expect(loop.destroy).toHaveBeenCalledOnce();
    expect(renderer.destroy).toHaveBeenCalledOnce();
    expect(presentation.destroy).toHaveBeenCalledOnce();
    expect(surface.destroy).toHaveBeenCalledOnce();
    expect(surface.element.isConnected).toBe(true);
    expect(surface.element.getAttribute('width')).toBe('320');
    expect(surface.element.getAttribute('height')).toBe('180');
    expect(surface.element.style.opacity).toBe('');
    expect(surface.element.hasAttribute('aria-hidden')).toBe(false);
    expect(presentation.device.destroy).not.toHaveBeenCalled();
  });

  it('applies construction options through renderer and uniforms', async () => {
    const h = await makeHarness({
      msaa: 4,
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
    expect(h.deps.Renderer).toHaveBeenCalledOnce();
    expect(h.deps.Renderer).toHaveBeenCalledWith(h.presentation, 4);
  });

  it('validates construction options before creating renderer resources', async () => {
    let deps!: ControllerDeps;

    await expect(
      createControllerHarness({ vertices: 1 } as unknown as Options, (next) => {
        deps = next;
      }),
    ).rejects.toThrow(TypeError);

    expect(deps.createSurface).not.toHaveBeenCalled();
    expect(deps.createPresentation).not.toHaveBeenCalled();
    expect(deps.Renderer).not.toHaveBeenCalled();
  });

  it('threads setOptions through renderer state and projection flags', async () => {
    const h = await makeHarness();

    h.network.setOptions({ vertices: false, graticule: true, earthAxis: false });

    expect(h.renderer.visibility.vertices).toBe(false);
    expect(h.renderer.visibility.earthAxis).toBe(false);
    expect(h.loop.uniforms.projection.flags & FLAG_GRATICULE).toBe(FLAG_GRATICULE);
    expect(h.loop.wake).toHaveBeenCalled();
  });

  it('filters construction-only msaa from live option patches', async () => {
    const h = await makeHarness({ msaa: 4 });
    h.renderer.setVisible.mockClear();
    h.loop.wake.mockClear();

    h.network.setOptions({ msaa: 1, vertices: false });

    expect(h.deps.Renderer).toHaveBeenCalledOnce();
    expect(h.deps.Renderer).toHaveBeenCalledWith(h.presentation, 4);
    expect(h.renderer.visibility.vertices).toBe(false);
    expect(h.renderer.setVisible).toHaveBeenCalledOnce();
    expect(h.loop.wake).toHaveBeenCalledOnce();
  });

  it('keeps empty and construction-only live option patches inert', async () => {
    const h = await makeHarness({ msaa: 4 });
    h.renderer.setVisible.mockClear();
    h.loop.wake.mockClear();

    h.network.setOptions({});
    h.network.setOptions({ msaa: 1 });

    expect(h.renderer.setVisible).not.toHaveBeenCalled();
    expect(h.loop.wake).not.toHaveBeenCalled();
  });

  it('validates a complete live patch before mutating renderer state', async () => {
    const h = await makeHarness();
    h.renderer.setVisible.mockClear();
    h.renderer.writeColormap.mockClear();
    h.loop.wake.mockClear();
    const uniformState = new Uint8Array(h.loop.uniforms.raw).slice();
    const visibility = { ...h.renderer.visibility };

    expect(() => h.network.setOptions({ vertices: false, terminatorWidth: -1 })).toThrow(
      RangeError,
    );

    expect(h.renderer.visibility).toEqual(visibility);
    expect(new Uint8Array(h.loop.uniforms.raw)).toEqual(uniformState);
    expect(h.renderer.setVisible).not.toHaveBeenCalled();
    expect(h.renderer.writeColormap).not.toHaveBeenCalled();
    expect(h.loop.wake).not.toHaveBeenCalled();
  });

  it('samples a colormap completely before applying any part of its option patch', async () => {
    const h = await makeHarness();
    h.renderer.setVisible.mockClear();
    h.renderer.writeColormap.mockClear();
    h.loop.wake.mockClear();
    const uniformState = new Uint8Array(h.loop.uniforms.raw).slice();
    const visibility = { ...h.renderer.visibility };
    const failure = new Error('colormap failed');

    expect(() =>
      h.network.setOptions({
        vertices: false,
        baseColor: [1, 0, 0, 1],
        colormap: (t) => {
          if (t > 0) throw failure;
          return [0, 0, 0];
        },
      }),
    ).toThrow(failure);

    expect(h.renderer.visibility).toEqual(visibility);
    expect(new Uint8Array(h.loop.uniforms.raw)).toEqual(uniformState);
    expect(h.renderer.setVisible).not.toHaveBeenCalled();
    expect(h.renderer.writeColormap).not.toHaveBeenCalled();
    expect(h.loop.wake).not.toHaveBeenCalled();
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

  it('exposes complete immutable projection records and replaces them after load', async () => {
    const h = await makeHarness();
    const beforeLoad = h.network.projections;

    expect(Object.keys(beforeLoad)).toEqual(['flat', 'tilt', 'globe']);
    expect(Object.isFrozen(beforeLoad)).toBe(true);
    expect(() => Object.assign(beforeLoad, { flat: !beforeLoad.flat })).toThrow(TypeError);

    h.network.load(geographicTopology());

    expect(h.network.projections).not.toBe(beforeLoad);
    expect(h.network.projections).toEqual({ flat: true, tilt: true, globe: true });
    expect(Object.isFrozen(h.network.projections)).toBe(true);
  });

  it('keeps renderer, loop, and picker callbacks wired to live controller state', async () => {
    const h = await makeHarness();
    const zooms: boolean[] = [];
    h.network.on('zoom', (atFitView) => zooms.push(atFitView));

    h.loop.deps?.onZoom?.(true);
    expect(zooms).toEqual([]);
    h.loop.paint();
    await flushMicrotasks();
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

  it('uses the caller canvas without exposing it as controller-owned state', async () => {
    const h = await makeHarness();

    expect(h.deps.createSurface).toHaveBeenCalledWith(h.canvas);
    expect(h.deps.createPresentation).toHaveBeenCalledWith(h.device, h.canvas);
    expect(h.canvas.hasAttribute('aria-hidden')).toBe(false);
    expect(h.network).not.toHaveProperty('element');
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

  it('keeps same-mode projection calls inert and falls back when new topology is incompatible', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    h.rig.switchTo.mockClear();
    h.renderer.useProjectionPipelines.mockClear();
    expect(h.network.setProjection('flat')).toBe(true);
    expect(h.rig.switchTo).not.toHaveBeenCalled();
    expect(h.renderer.useProjectionPipelines).not.toHaveBeenCalled();

    expect(h.network.setProjection('globe')).toBe(true);
    h.rig.switchTo.mockClear();
    h.renderer.useProjectionPipelines.mockClear();
    h.network.load(nonGlobeTopology());

    expect(h.rig.switchTo).toHaveBeenCalledWith('flat', expect.anything(), { w: 100, h: 80 });
    expect(h.renderer.useProjectionPipelines).toHaveBeenCalledWith('flat');
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
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    expect(hovers).toEqual([]);
    h.loop.paint();
    await flushMicrotasks();

    h.picker.nextHits = [['edge', 0]];
    h.emitPointer({ kind: 'tap', sx: 5, sy: 6, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(hovers).toEqual([['vertex', 1]]);
    expect(selects).toEqual([['edge', 0]]);
  });

  it('routes movement pointer intents to the active camera', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    h.emitPointer({ kind: 'dragStart', sx: 1, sy: 2, vp: { w: 100, h: 80 }, time: 10 });
    h.emitPointer({
      kind: 'dragMove',
      dx: 3,
      dy: 4,
      sx: 5,
      sy: 6,
      vp: { w: 100, h: 80 },
      time: 20,
    });
    h.emitPointer({ kind: 'dragEnd', coast: true, time: 30 });
    h.emitPointer({ kind: 'pan', dx: 7, dy: 8, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'zoom', factor: 1.5, sx: 9, sy: 10, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'rotate', dxPx: 11, dyPx: 12, vp: { w: 100, h: 80 } });
    h.emitPointer({ kind: 'doubleTap', sx: 50, sy: 40, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(h.rig.camera.beginDrag).toHaveBeenCalledWith(1, 2, { w: 100, h: 80 }, 10);
    expect(h.rig.camera.drag).toHaveBeenCalledWith(3, 4, 5, 6, { w: 100, h: 80 }, 20);
    expect(h.rig.camera.endDrag).toHaveBeenCalledWith(true, 30);
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
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    h.loop.paint();
    await flushMicrotasks();
    h.emitPointer({ kind: 'hoverEnd' });
    h.loop.frame();
    h.loop.paint();
    await flushMicrotasks();
    h.picker.nextHits = [];
    h.emitPointer({ kind: 'tap', sx: 5, sy: 6, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(hovers).toEqual([
      ['vertex', 1],
      [null, null],
    ]);
    expect(selects).toEqual([[null, null]]);
  });

  it('clears only hover during navigation and restores it after the camera settles', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.network.select('vertex', 2);
    h.picker.nextHit = ['edge', 0];
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();

    h.emitPointer({ kind: 'navigationStart' });
    expect(h.loop.uniforms.focus.hoverEdge).toBe(-1);
    expect(h.loop.uniforms.focus.selectedVertex).toBe(2);

    h.picker.pick.mockClear();
    h.emitPointer({
      kind: 'navigationEnd',
      probe: { clientX: 7, clientY: 8, targetPx: 10 },
    });
    h.rig.camera.isAnimating.mockReturnValue(true);
    h.loop.frame();
    expect(h.picker.pick).not.toHaveBeenCalled();

    h.rig.camera.isAnimating.mockReturnValue(false);
    h.loop.frame();
    expect(h.picker.pick).toHaveBeenCalledOnce();
    expect(h.picker.lastQuery).toMatchObject({ sx: 7, sy: 8 });
  });

  it('uses the current DOMRect, waits for resize settlement, and avoids redundant static picks', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    vi.spyOn(h.surface, 'rect').mockReturnValue(new DOMRect(10, 20, 100, 80));
    h.picker.nextHit = ['vertex', 1];
    h.emitPointer({ kind: 'hover', clientX: 15, clientY: 26, targetPx: 10 });

    h.loop.frame(undefined, false);
    expect(h.picker.pick).not.toHaveBeenCalled();
    h.loop.frame(undefined, true);
    expect(h.picker.pick).toHaveBeenCalledOnce();
    expect(h.picker.lastQuery).toMatchObject({ sx: 5, sy: 6, vp: { w: 100, h: 80 } });

    h.loop.frame(undefined, true);
    expect(h.picker.pick).toHaveBeenCalledOnce();
  });

  it('does not dirty or wake hover for rejected public camera input', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    h.picker.pick.mockClear();
    h.loop.wake.mockClear();
    h.rig.camera.panBy.mockReturnValue(false);
    h.rig.camera.zoomAt.mockReturnValue(false);

    h.network.panBy(0, 0);
    h.network.panBy(Number.NaN, 1);
    h.network.zoomBy(1);
    h.network.zoomBy(0);

    expect(h.loop.wake).not.toHaveBeenCalled();
    h.loop.frame();
    expect(h.picker.pick).not.toHaveBeenCalled();
  });

  it('invalidates hover only for streams and visibility that affect hit geometry', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    h.picker.pick.mockClear();

    h.network.setChannel('vertexColor', new Float32Array([0, 0.5, 1]));
    h.network.setOptions({ daylight: false, baseColor: [0.2, 0.3, 0.4, 1] });
    h.loop.frame();
    expect(h.picker.pick).not.toHaveBeenCalled();

    h.network.setChannel('vertexSize', new Float32Array([1, 2, 3]));
    h.loop.frame();
    expect(h.picker.pick).toHaveBeenCalledOnce();

    h.picker.pick.mockClear();
    h.network.setOptions({ vertices: false });
    h.loop.frame();
    expect(h.picker.pick).toHaveBeenCalledOnce();
    expect(h.picker.lastQuery?.vertices).toBe(false);
  });

  it('delivers painted hover notifications after the render tick, preventing reentrant scene mutation', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.picker.nextHit = ['vertex', 1];
    let insidePaint = false;
    const callbackStates: boolean[] = [];
    h.network.on('hover', () => {
      callbackStates.push(insidePaint);
      h.network.setProjection('tilt');
      h.network.load(nonGlobeTopology());
    });

    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    expect(callbackStates).toEqual([]);

    insidePaint = true;
    h.loop.paint();
    insidePaint = false;
    expect(callbackStates).toEqual([]);
    await flushMicrotasks();

    expect(callbackStates).toEqual([false]);
    expect(h.rig.switchTo).toHaveBeenCalledWith('tilt', expect.anything(), { w: 100, h: 80 });
    expect(h.loop.frameNow).toHaveBeenCalled();
  });

  it('coalesces zoom notifications until paint and keeps zoom listeners out of the render tick', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    let insidePaint = false;
    const notices: Array<{ atFit: boolean; insidePaint: boolean }> = [];
    let hoverNotices = 0;
    h.network.on('hover', () => hoverNotices++);
    h.network.on('zoom', (atFit) => {
      notices.push({ atFit, insidePaint });
      h.network.setProjection('tilt');
      h.network.load(nonGlobeTopology());
    });

    h.picker.nextHit = ['vertex', 1];
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    h.loop.deps?.onZoom?.(false);
    h.loop.deps?.onZoom?.(true);
    expect(notices).toEqual([]);

    insidePaint = true;
    h.loop.paint();
    insidePaint = false;
    expect(notices).toEqual([]);
    await flushMicrotasks();

    expect(notices).toEqual([{ atFit: true, insidePaint: false }]);
    expect(hoverNotices).toBe(0);
    expect(h.rig.switchTo).toHaveBeenCalledWith('tilt', expect.anything(), { w: 100, h: 80 });
    expect(h.loop.frameNow).toHaveBeenCalled();
  });

  it('retains the physical hover probe and re-picks after topology reload', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    h.picker.pick.mockClear();

    h.network.load(geographicTopology());
    h.loop.frame();

    expect(h.picker.pick).toHaveBeenCalledOnce();
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

  it('picks hover once settled and suppresses all live picks while navigating or animating', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.picker.nextHit = ['edge', 0];
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.rig.camera.isAnimating.mockReturnValue(true);
    h.loop.frame();
    h.loop.frame();
    expect(h.picker.pick).not.toHaveBeenCalled();

    h.rig.camera.isAnimating.mockReturnValue(false);
    h.loop.frame();
    expect(h.picker.pick).toHaveBeenCalledOnce();

    h.emitPointer({ kind: 'navigationStart' });
    h.picker.pick.mockClear();
    h.loop.frame();
    expect(h.picker.pick).not.toHaveBeenCalled();
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

  it('immediately notifies late device-loss subscribers exactly once', async () => {
    const h = await makeHarness();
    h.deviceLost.resolve({ reason: 'unknown', message: 'already lost' } as GPUDeviceLostInfo);
    await flushMicrotasks();
    const late = vi.fn<Events['deviceLost']>();

    const unsubscribe = h.network.on('deviceLost', late);

    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith('unknown', 'already lost');
    expect(h.events.deviceLost).toEqual([['unknown', 'already lost']]);
    await flushMicrotasks();
    expect(late).toHaveBeenCalledOnce();

    unsubscribe();
  });

  it('forwards destruction of a borrowed device while the controller is live', async () => {
    const h = await makeHarness();

    h.deviceLost.resolve({ reason: 'destroyed', message: 'normal shutdown' } as GPUDeviceLostInfo);
    await flushMicrotasks();

    expect(h.loop.pause).toHaveBeenCalledOnce();
    expect(h.events.deviceLost).toEqual([['destroyed', 'normal shutdown']]);
  });

  it('ignores device loss after controller teardown', async () => {
    const h = await makeHarness();
    h.network.destroy();

    h.deviceLost.resolve({ reason: 'unknown', message: 'late loss' } as GPUDeviceLostInfo);
    await flushMicrotasks();

    expect(h.loop.pause).not.toHaveBeenCalled();
    expect(h.events.deviceLost).toEqual([]);
  });

  it('idempotently destroys owned collaborators without destroying the borrowed device', async () => {
    const h = await makeHarness();
    h.presentation.resize(800, 450);

    h.network.destroy();
    h.network.destroy();

    expect(h.deps.createPresentation).toHaveBeenCalledWith(h.device, h.canvas);
    expect(h.loop.destroy).toHaveBeenCalledOnce();
    expect(h.pointerCleanup.destroy).toHaveBeenCalledOnce();
    expect(h.renderer.destroy).toHaveBeenCalledOnce();
    expect(h.presentation.destroy).toHaveBeenCalledOnce();
    expect(h.surface.destroy).toHaveBeenCalledOnce();
    expect(h.canvas.isConnected).toBe(true);
    expect(h.canvas.getAttribute('width')).toBe('320');
    expect(h.canvas.getAttribute('height')).toBe('180');
    expect(h.canvas.style.opacity).toBe('');
    expect(h.deviceDestroy).not.toHaveBeenCalled();
  });
});
