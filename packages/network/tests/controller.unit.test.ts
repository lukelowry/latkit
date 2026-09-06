// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetwork } from '../src/controller.js';
import type { Item } from '@latkit/model';

import type { ControllerDeps, Events, Options } from '../src/controller.js';
import {
  DISPLAY_EDGE_BASE_COLOR,
  DISPLAY_DAYLIGHT,
  FOCUS_ENABLED,
  FOCUS_HOVER_ENDPOINTS,
  FOCUS_SELECTED_ENDPOINTS,
  DISPLAY_GEOGRAPHIC,
  DISPLAY_GRATICULE,
  DISPLAY_VERTICES,
} from '../src/webgpu/uniforms.js';
import { VISUAL } from '../src/visual.js';
import {
  createControllerHarness,
  deferred,
  fakePool,
  flushMicrotasks,
} from './fixtures/controller-harness.js';
import { geographicTopology, nonGlobeTopology, ringTopology } from './fixtures/topology.js';

type Harness = Awaited<ReturnType<typeof createControllerHarness>>;

let harnesses: Harness[] = [];

async function makeHarness(
  options: Options = {},
  configure?: (deps: ControllerDeps) => void,
  attach = true,
): Promise<Harness> {
  const harness = await createControllerHarness(options, configure, attach);
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

describe('createNetwork construction', () => {
  it('constructs synchronously without a device or a canvas and validates options first', () => {
    const network = createNetwork({ graticule: true });
    expect(network.attached).toBe(false);
    expect(network.projections).toEqual({ flat: true, tilt: true, globe: false });
    expect(() => createNetwork({ vertices: 1 } as unknown as Options)).toThrow(TypeError);
    network.destroy();
  });

  it('validates construction options before touching any collaborator', async () => {
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

  it('loads topology, binds channels, and selects before any canvas exists', async () => {
    const h = await makeHarness({}, undefined, false);

    h.network.load(geographicTopology());
    h.network.setChannel('vertexColor', new Float32Array([0, 0.5, 1]), [0, 1]);
    h.network.select({ kind: 'vertex', index: 1 });

    expect(h.network.projections.globe).toBe(true);
    expect(h.network.geographic).toBe(true);
    expect(h.network.getChannelDomain('vertexColor')).toEqual([0, 1]);
    expect(h.renderer.bindTopology).not.toHaveBeenCalled();
    expect(h.network.hitTest(5, 6)).toEqual([]);
    expect(h.network.locate({ kind: 'vertex', index: 1 })).toBeNull();

    await h.network.attach(h.canvas);

    expect(h.loop.uniforms.focus.vSelectedId).toBe(1);
    expect(h.renderer.bindTopology).toHaveBeenCalledOnce();
  });
});

describe('attach and detach', () => {
  it('leases a device, binds the canvas, and replays every retained state', async () => {
    const h = await makeHarness({ colormap: (t) => [t, 0, 1 - t] }, undefined, false);
    const borders = { vertices: new Uint8Array(0), indices: new Uint32Array(0) };
    h.network.load(geographicTopology());
    h.network.setChannel('vertexColor', new Float32Array([0, 0.5, 1]), [0, 1]);
    h.network.setChannel('edgeDash', new Float32Array([1, 0]));
    h.network.setBorders(borders);
    h.network.setProjection('tilt');
    h.network.setOptions({ vertices: false });

    await h.network.attach(h.canvas);

    expect(h.network.attached).toBe(true);
    expect(h.events.attached).toEqual([true]);
    expect(h.pool.devices).toHaveLength(1);
    expect(h.deps.createPresentation).toHaveBeenCalledWith(h.device, h.canvas);
    expect(h.deps.Renderer).toHaveBeenCalledWith(h.presentation, undefined);
    expect(h.renderer.writeColormap).toHaveBeenCalledOnce();
    expect(h.renderer.bindTopology).toHaveBeenCalledOnce();
    expect(h.renderer.useProjection).toHaveBeenLastCalledWith('tilt');
    expect(h.renderer.channelWrites.map((write) => write.channel)).toEqual([
      'vertexColor',
      'edgeDash',
    ]);
    expect(h.renderer.setBorders).toHaveBeenLastCalledWith(borders);
    expect(h.renderer.passes).toMatchObject({ vertices: false, borders: true });
    expect(h.loop.frameNow).toHaveBeenCalled();
    expect(h.deps.attachKeyboard).toHaveBeenCalledWith(h.canvas, expect.any(Function));
  });

  it('detaches without forgetting, and a second attach replays onto a new canvas', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.network.setChannel('vertexHeight', new Float32Array([1, 2, 3]));
    h.network.select({ kind: 'edge', index: 0 });
    h.renderer.bindTopology.mockClear();
    h.renderer.channelWrites.length = 0;

    h.network.detach();

    expect(h.network.attached).toBe(false);
    expect(h.events.attached).toEqual([true, false]);
    expect(h.loop.destroy).toHaveBeenCalledOnce();
    expect(h.pointerCleanup.destroy).toHaveBeenCalledOnce();
    expect(h.keyboardCleanup.destroy).toHaveBeenCalledOnce();
    expect(h.renderer.destroy).toHaveBeenCalledOnce();
    expect(h.presentation.destroy).toHaveBeenCalledOnce();
    expect(h.surface.destroy).toHaveBeenCalledOnce();
    expect(h.pool.releases).toHaveBeenCalledOnce();
    expect(h.network.projections.globe).toBe(true);
    expect(h.network.getChannelDomain('vertexHeight')).toEqual([1, 3]);
    expect(h.loop.uniforms.focus.eSelectedId).toBe(0);
    expect(h.canvas.getAttribute('width')).toBe('320');

    const next = document.createElement('canvas');
    document.body.append(next);
    await h.network.attach(next);

    expect(h.network.attached).toBe(true);
    expect(h.pool.devices).toHaveLength(2);
    expect(h.deps.createPresentation).toHaveBeenLastCalledWith(h.device, next);
    expect(h.renderer.bindTopology).toHaveBeenCalledOnce();
    expect(h.renderer.channelWrites.map((write) => write.channel)).toEqual(['vertexHeight']);
    expect(h.events.attached).toEqual([true, false, true]);
  });

  it('rejects an attach overtaken by a newer attach or a detach and returns its lease', async () => {
    const h = await makeHarness({}, undefined, false);
    const release = h.pool.hold();

    const overtaken = h.network.attach(h.canvas);
    const next = document.createElement('canvas');
    document.body.append(next);
    const current = h.network.attach(next);
    release();

    await expect(overtaken).rejects.toMatchObject({ name: 'AbortError' });
    await current;
    expect(h.network.attached).toBe(true);
    expect(h.pool.devices).toHaveLength(2);
    expect(h.pool.releases).toHaveBeenCalledOnce();
    expect(h.deps.createPresentation).toHaveBeenCalledOnce();
    const [presented, target] = vi.mocked(h.deps.createPresentation).mock.calls[0]!;
    expect(target).toBe(next);
    expect(h.pool.devices.map((entry) => entry.device)).toContain(presented);
    expect(h.pool.releases.mock.calls[0]![0]).not.toBe(presented);

    const gate = h.pool.hold();
    const detached = h.network.attach(h.canvas);
    h.network.detach();
    gate();
    await expect(detached).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.network.attached).toBe(false);
    // The live binding's lease, then the lease the overtaken attach never used.
    expect(h.pool.releases).toHaveBeenCalledTimes(3);
  });

  it('rejects non-Core devices and returns the lease before creating a surface', async () => {
    const h = await makeHarness({}, undefined, false);
    h.pool.devices.push({
      device: { limits: { maxStorageBuffersInVertexStage: 0 } } as unknown as GPUDevice,
      lost: deferred(),
      destroy: vi.fn(),
    });
    const pool = {
      acquire: () =>
        Promise.resolve({ device: h.pool.devices[0]!.device, release: h.pool.releases }),
    };
    const network = createNetwork({ devices: pool });

    await expect(network.attach(h.canvas)).rejects.toThrow('A Core WebGPU device is required');
    expect(h.pool.releases).toHaveBeenCalledOnce();
    expect(h.canvas.isConnected).toBe(true);
    network.destroy();
  });

  it('surfaces canvas setup failures without mutating the borrowed canvas', async () => {
    const h = await makeHarness({}, undefined, false);
    h.canvas.style.touchAction = 'pan-x';
    h.canvas.style.userSelect = 'text';
    h.canvas.style.opacity = '0.5';
    h.canvas.setAttribute('aria-hidden', 'false');
    vi.mocked(h.deps.createPresentation).mockImplementationOnce(() => {
      throw new Error('WebGPU canvas context unavailable');
    });

    await expect(h.network.attach(h.canvas)).rejects.toThrow('WebGPU canvas context unavailable');

    expect(h.network.attached).toBe(false);
    expect(h.events.attached).toEqual([]);
    expect(h.canvas.isConnected).toBe(true);
    expect(h.canvas.style.opacity).toBe('0.5');
    expect(h.canvas.getAttribute('aria-hidden')).toBe('false');
    expect(h.canvas.getAttribute('width')).toBe('320');
    expect(h.canvas.getAttribute('height')).toBe('180');
    expect(h.surface.destroy).toHaveBeenCalledOnce();
    expect(h.pool.releases).toHaveBeenCalledOnce();
    expect(h.pool.devices[0]!.destroy).not.toHaveBeenCalled();
  });

  it('cleans partial initialization and preserves the original error', async () => {
    const failure = new Error('pointer setup failed');
    const h = await makeHarness(
      {},
      (deps) => {
        deps.attachPointer = vi.fn(() => {
          throw failure;
        });
      },
      false,
    );

    await expect(h.network.attach(h.canvas)).rejects.toBe(failure);

    expect(h.loop.destroy).toHaveBeenCalledOnce();
    expect(h.renderer.destroy).toHaveBeenCalledOnce();
    expect(h.presentation.destroy).toHaveBeenCalledOnce();
    expect(h.surface.destroy).toHaveBeenCalledOnce();
    expect(h.pool.releases).toHaveBeenCalledOnce();
    expect(h.canvas.getAttribute('width')).toBe('320');
    expect(h.network.attached).toBe(false);
  });

  it('propagates a replay failure and releases the binding it could not finish', async () => {
    const h = await makeHarness({}, undefined, false);
    h.network.load(geographicTopology());
    h.renderer.bindTopology.mockImplementationOnce(() => {
      throw new Error('GPU allocation failed');
    });

    await expect(h.network.attach(h.canvas)).rejects.toThrow('GPU allocation failed');

    expect(h.network.attached).toBe(false);
    expect(h.events.attached).toEqual([]);
    expect(h.pool.releases).toHaveBeenCalledOnce();
    expect(h.network.projections.globe).toBe(true);
  });

  it('refuses to attach after destroy', async () => {
    const h = await makeHarness();
    h.network.destroy();
    await expect(h.network.attach(h.canvas)).rejects.toThrow('destroyed');
  });
});

describe('device loss', () => {
  it('releases the lost device, says so, and re-attaches on a replacement', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.network.setChannel('vertexColor', new Float32Array([0, 0.5, 1]));
    h.renderer.bindTopology.mockClear();
    h.renderer.channelWrites.length = 0;

    h.loseDevice({ reason: 'unknown', message: 'lost for test' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(h.events.deviceLost).toEqual([
      { reason: 'unknown', message: 'lost for test', recovering: true },
    ]);
    expect(h.events.attached).toEqual([true, false, true]);
    expect(h.pool.devices).toHaveLength(2);
    expect(h.pool.releases).toHaveBeenCalledExactlyOnceWith(h.pool.devices[0]!.device);
    expect(h.deps.Renderer).toHaveBeenCalledTimes(2);
    expect(h.renderer.bindTopology).toHaveBeenCalledOnce();
    expect(h.renderer.channelWrites.map((write) => write.channel)).toEqual(['vertexColor']);
    expect(h.network.attached).toBe(true);
  });

  it('reports a recovery that cannot lease a replacement and stays detached', async () => {
    const h = await makeHarness();
    h.pool.fail(new Error('No Core WebGPU adapter is available'));

    h.loseDevice({ reason: 'destroyed', message: 'normal shutdown' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(h.events.deviceLost).toEqual([
      { reason: 'destroyed', message: 'normal shutdown', recovering: true },
      { reason: 'unavailable', message: 'No Core WebGPU adapter is available', recovering: false },
    ]);
    expect(h.network.attached).toBe(false);
  });

  it('ignores a loss reported for a device it no longer holds', async () => {
    const h = await makeHarness();
    h.network.detach();
    h.loseDevice();
    await flushMicrotasks();
    expect(h.events.deviceLost).toEqual([]);

    await h.network.attach(h.canvas);
    h.loseDevice({}, 0);
    await flushMicrotasks();
    expect(h.events.deviceLost).toEqual([]);
    expect(h.pool.devices).toHaveLength(2);
  });

  it('ignores device loss after controller teardown', async () => {
    const h = await makeHarness();
    h.network.destroy();

    h.loseDevice({ reason: 'unknown', message: 'late loss' });
    await flushMicrotasks();

    expect(h.events.deviceLost).toEqual([]);
  });
});

describe('createNetwork controller', () => {
  it('applies construction options through renderer and uniforms', async () => {
    const h = await makeHarness({
      msaa: 4,
      vertices: false,
      earthAxis: false,
      graticule: true,
      daylight: false,
      vertexBaseColor: [0.1, 0.2, 0.3, 1],
      colormap: (t) => [t, 0, 1 - t],
      graticuleColor: [0.2, 0.3, 0.4, 1],
      surfaceColor: [0.3, 0.4, 0.5, 1],
      borderColor: [0.4, 0.5, 0.6, 1],
    });

    expect(h.renderer.passes).toMatchObject({
      vertices: false,
      edges: true,
      poles: false,
      borders: false,
      earthAxis: false,
    });
    expect(h.loop.uniforms.display.flags & DISPLAY_GRATICULE).toBe(DISPLAY_GRATICULE);
    expect(h.loop.uniforms.display.flags & DISPLAY_DAYLIGHT).toBe(0);
    expectRgbaClose(h.loop.uniforms.vBaseColor, [0.1, 0.2, 0.3, 1]);
    expectRgbaClose(h.loop.uniforms.graticuleColor, [0.2, 0.3, 0.4, 1]);
    expectRgbaClose(h.loop.uniforms.surfaceColor, [0.3, 0.4, 0.5, 1]);
    expectRgbaClose(h.loop.uniforms.borderColor, [0.4, 0.5, 0.6, 1]);
    expect(h.renderer.writeColormap).toHaveBeenCalledOnce();
    expect(h.deps.Renderer).toHaveBeenCalledOnce();
    expect(h.deps.Renderer).toHaveBeenCalledWith(h.presentation, 4);
  });

  it('threads setOptions through renderer state and projection flags', async () => {
    const h = await makeHarness();

    h.network.setOptions({ vertices: false, graticule: true, earthAxis: false });

    expect(h.renderer.passes.vertices).toBe(false);
    expect(h.renderer.passes.earthAxis).toBe(false);
    expect(h.loop.uniforms.display.flags & DISPLAY_GRATICULE).toBe(DISPLAY_GRATICULE);
    expect(h.loop.wake).toHaveBeenCalled();
  });

  it('applies global geometry scales and the active dash period', async () => {
    const baseline = await makeHarness();
    baseline.network.load(geographicTopology());
    const h = await makeHarness({
      vertexScale: 2,
      edgeScale: 3,
      dashPeriodPx: 18,
    });
    h.network.load(geographicTopology());

    expect(h.loop.uniforms.geometry.vRadius).toBeCloseTo(
      baseline.loop.uniforms.geometry.vRadius * 2,
    );
    expect(h.loop.uniforms.geometry.eHalfWidth).toBeCloseTo(
      baseline.loop.uniforms.geometry.eHalfWidth * 3,
    );

    const height = h.loop.uniforms.geometry.heightAmplitude;
    h.network.setOptions({ heightScale: 4 });
    expect(h.loop.uniforms.geometry.heightAmplitude).toBeCloseTo(height * 4);

    h.network.setChannel('edgeDash', new Float32Array([0, 1]));
    expect(h.loop.uniforms.geometry.eDashPeriodPx).toBe(18);
    h.network.setOptions({ dashPeriodPx: 6 });
    expect(h.loop.uniforms.geometry.eDashPeriodPx).toBe(6);
    h.network.setChannel('edgeDash', null);
    expect(h.loop.uniforms.geometry.eDashPeriodPx).toBe(0);
  });

  it('filters construction-only msaa and devices from live option patches', async () => {
    const h = await makeHarness({ msaa: 4 });
    h.renderer.setPasses.mockClear();
    h.loop.wake.mockClear();

    h.network.setOptions({ msaa: 1, devices: fakePool(), vertices: false });

    expect(h.deps.Renderer).toHaveBeenCalledOnce();
    expect(h.deps.Renderer).toHaveBeenCalledWith(h.presentation, 4);
    expect(h.renderer.passes.vertices).toBe(false);
    expect(h.renderer.setPasses).toHaveBeenCalledOnce();
    expect(h.loop.wake).toHaveBeenCalledOnce();
  });

  it('keeps empty and construction-only live option patches inert', async () => {
    const h = await makeHarness({ msaa: 4 });
    h.renderer.setPasses.mockClear();
    h.loop.wake.mockClear();

    h.network.setOptions({});
    h.network.setOptions({ msaa: 1 });

    expect(h.renderer.setPasses).not.toHaveBeenCalled();
    expect(h.loop.wake).not.toHaveBeenCalled();
  });

  it('validates a complete live patch before mutating renderer state', async () => {
    const h = await makeHarness();
    h.renderer.setPasses.mockClear();
    h.renderer.writeColormap.mockClear();
    h.loop.wake.mockClear();
    const uniformState = new Uint8Array(h.loop.uniforms.raw).slice();
    const passes = { ...h.renderer.passes };

    expect(() => h.network.setOptions({ vertices: false, terminatorWidth: -1 })).toThrow(
      RangeError,
    );

    expect(h.renderer.passes).toEqual(passes);
    expect(new Uint8Array(h.loop.uniforms.raw)).toEqual(uniformState);
    expect(h.renderer.setPasses).not.toHaveBeenCalled();
    expect(h.renderer.writeColormap).not.toHaveBeenCalled();
    expect(h.loop.wake).not.toHaveBeenCalled();
  });

  it('samples a colormap completely before applying any part of its option patch', async () => {
    const h = await makeHarness();
    h.renderer.setPasses.mockClear();
    h.renderer.writeColormap.mockClear();
    h.loop.wake.mockClear();
    const uniformState = new Uint8Array(h.loop.uniforms.raw).slice();
    const passes = { ...h.renderer.passes };
    const failure = new Error('colormap failed');

    expect(() =>
      h.network.setOptions({
        vertices: false,
        vertexBaseColor: [1, 0, 0, 1],
        colormap: (t) => {
          if (t > 0) throw failure;
          return [0, 0, 0];
        },
      }),
    ).toThrow(failure);

    expect(h.renderer.passes).toEqual(passes);
    expect(new Uint8Array(h.loop.uniforms.raw)).toEqual(uniformState);
    expect(h.renderer.setPasses).not.toHaveBeenCalled();
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
    expect(h.loop.uniforms.focus.vHoverPx).toBe(8);
    expect(h.loop.uniforms.focus.vSelectedPx).toBe(9);
    expect(h.loop.uniforms.focus.eHoverPx).toBe(4);
    expect(h.loop.uniforms.focus.eSelectedPx).toBe(5);
    expect(h.loop.uniforms.focus.flags & FOCUS_ENABLED).toBe(FOCUS_ENABLED);
    expect(h.loop.uniforms.focus.flags & FOCUS_SELECTED_ENDPOINTS).toBe(FOCUS_SELECTED_ENDPOINTS);
    expect(h.loop.uniforms.focus.flags & FOCUS_HOVER_ENDPOINTS).toBe(FOCUS_HOVER_ENDPOINTS);

    h.network.setOptions({ focusEnabled: false });

    expect(h.loop.uniforms.focus.flags).toBe(0);
  });

  it('loads topology into renderer and picker, updates projections, and requests first frame', async () => {
    const h = await makeHarness();

    h.network.load(geographicTopology());

    expect(h.renderer.bindTopology).toHaveBeenCalledOnce();
    expect(h.picker.prepareScene).toHaveBeenCalledOnce();
    expect(h.picker.commitScene).toHaveBeenCalledOnce();
    expect(h.picker.prepareScene.mock.invocationCallOrder[0]).toBeLessThan(
      h.renderer.bindTopology.mock.invocationCallOrder[0]!,
    );
    expect(h.renderer.bindTopology.mock.invocationCallOrder[0]).toBeLessThan(
      h.picker.commitScene.mock.invocationCallOrder[0]!,
    );
    expect(h.network.projections).toMatchObject({ flat: true, tilt: true, globe: true });
    expect(h.rig.setBounds).toHaveBeenLastCalledWith(expect.anything(), true);
    expect(h.loop.frameNow).toHaveBeenCalled();
  });

  it('keeps the pose on a reload that asks not to fit', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    h.network.load(nonGlobeTopology(), { fit: false });

    expect(h.rig.setBounds).toHaveBeenLastCalledWith(expect.anything(), false);
    expect(h.renderer.bindTopology).toHaveBeenCalledTimes(2);
  });

  it('recognizes the loaded topology and keeps channels, selection, and camera on a reload', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.network.setChannel('vertexColor', new Float32Array([0, 0.5, 1]), [0, 1]);
    h.network.select({ kind: 'vertex', index: 2 });
    h.renderer.bindTopology.mockClear();
    h.rig.setBounds.mockClear();
    h.loop.frameNow.mockClear();

    h.network.load(geographicTopology());
    h.network.load({ ...geographicTopology(), polylinePoints: new Float32Array([3, 4, 7, 0]) });

    expect(h.renderer.bindTopology).not.toHaveBeenCalled();
    expect(h.rig.setBounds).not.toHaveBeenCalled();
    expect(h.loop.frameNow).not.toHaveBeenCalled();
    expect(h.network.getChannelDomain('vertexColor')).toEqual([0, 1]);
    expect(h.loop.uniforms.focus.vSelectedId).toBe(2);

    h.network.load({ ...geographicTopology(), coordinateSpace: 'cartesian' });
    expect(h.renderer.bindTopology).toHaveBeenCalledOnce();
    expect(h.network.getChannelDomain('vertexColor')).toBeNull();
  });

  it('uses canonical vertex bounds for fit and sizing across projections', async () => {
    const h = await makeHarness();
    h.network.load({
      ...geographicTopology(),
      polylinePoints: new Float32Array([30, -20, 40, 4]),
    });

    const bounds = h.rig.setBounds.mock.calls.at(-1)?.[0];
    expect(bounds).toMatchObject({ xMin: -10, xMax: 10, yMin: -5, yMax: 5 });
    const vertexSize = Math.sqrt((20 * 10) / 3) * 0.08;
    expect(h.loop.uniforms.geometry.vRadius).toBeCloseTo(vertexSize);

    h.network.fit(true);
    expect(h.rig.fit).toHaveBeenCalledWith({ w: 100, h: 80 }, true);
    expect(h.network.projections.globe).toBe(true);

    const boundsWrites = h.rig.setBounds.mock.calls.length;
    h.network.setProjection('globe');
    expect(h.rig.setBounds).toHaveBeenCalledTimes(boundsWrites);
    expect(h.loop.uniforms.geometry.vRadius).toBeCloseTo(vertexSize);
  });

  it('keeps the previous scene when picker preparation fails', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const previousPickerScene = h.picker.scene;
    const previousTopology = h.renderer.encodedTopology;

    h.renderer.bindTopology.mockClear();
    h.picker.commitScene.mockClear();
    h.picker.prepareScene.mockImplementationOnce(() => {
      throw new Error('grid allocation failed');
    });

    expect(() => h.network.load(nonGlobeTopology())).toThrow('grid allocation failed');
    expect(h.renderer.bindTopology).not.toHaveBeenCalled();
    expect(h.picker.commitScene).not.toHaveBeenCalled();
    expect(h.picker.scene).toBe(previousPickerScene);
    expect(h.renderer.encodedTopology).toBe(previousTopology);
    expect(h.network.projections.globe).toBe(true);
  });

  it('does not commit the prepared picker scene when GPU binding fails', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const previousPickerScene = h.picker.scene;
    const previousTopology = h.renderer.encodedTopology;

    h.picker.prepareScene.mockClear();
    h.picker.commitScene.mockClear();
    h.renderer.bindTopology.mockImplementationOnce(() => {
      throw new Error('GPU allocation failed');
    });

    expect(() => h.network.load(nonGlobeTopology())).toThrow('GPU allocation failed');
    expect(h.picker.prepareScene).toHaveBeenCalledOnce();
    expect(h.picker.commitScene).not.toHaveBeenCalled();
    expect(h.picker.scene).toBe(previousPickerScene);
    expect(h.renderer.encodedTopology).toBe(previousTopology);
    expect(h.network.projections.globe).toBe(true);
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

  it('keeps globe availability based on vertices when an edge bend crosses longitude 180', async () => {
    const h = await makeHarness();
    const topology = geographicTopology();

    h.network.load({
      ...topology,
      polylinePoints: new Float32Array([181, 4, -179, 0]),
    });

    expect(h.network.projections.globe).toBe(true);
  });

  it('keeps renderer, loop, and picker callbacks wired to live controller state', async () => {
    const h = await makeHarness();
    const fits: boolean[] = [];
    h.network.on('fit', (atFitView) => fits.push(atFitView));

    h.loop.deps?.onZoom?.(true);
    expect(fits).toEqual([]);
    h.loop.paint();
    await flushMicrotasks();
    expect(fits).toEqual([true]);

    h.loop.wake.mockClear();
    h.renderer.onPipelinesReady?.();
    expect(h.loop.wake).toHaveBeenCalledOnce();

    expect(h.picker.deps?.mode()).toBe('flat');
    expect(h.picker.deps?.unproject(1, 2, { w: 100, h: 80 })).toEqual([0, 0]);

    const values = new Float32Array([0, 0.5, 1]);
    h.network.load(geographicTopology());
    h.network.setChannel('vertexHeight', values);
    expect(h.picker.deps?.values('vertexHeight')).not.toBe(values);
    expect(h.picker.deps?.values('vertexHeight')).toEqual(values);
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
    expect(h.rig.switchTo).not.toHaveBeenCalledWith('globe', expect.anything());
    expect(h.renderer.useProjection).not.toHaveBeenCalledWith('globe');
  });

  it('switches supported projections through the rig and renderer together', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    expect(h.network.setProjection('tilt')).toBe(true);
    expect(h.rig.switchTo).toHaveBeenCalledWith('tilt', { w: 100, h: 80 });
    expect(h.renderer.useProjection).toHaveBeenCalledWith('tilt');
    expect(h.loop.wake).toHaveBeenCalled();
  });

  it('keeps same-mode projection calls inert and falls back when new topology is incompatible', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    h.rig.switchTo.mockClear();
    h.renderer.useProjection.mockClear();
    expect(h.network.setProjection('flat')).toBe(true);
    expect(h.rig.switchTo).not.toHaveBeenCalled();
    expect(h.renderer.useProjection).not.toHaveBeenCalled();

    expect(h.network.setProjection('globe')).toBe(true);
    h.rig.switchTo.mockClear();
    h.renderer.useProjection.mockClear();
    h.network.load(nonGlobeTopology());

    expect(h.rig.switchTo).toHaveBeenCalledWith('flat', { w: 100, h: 80 });
    expect(h.renderer.useProjection).toHaveBeenCalledWith('flat');
  });

  it('routes display mutators through renderer, channels, uniforms, and repaint', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.loop.wake.mockClear();

    h.network.setBorders({ vertices: new Uint8Array(0), indices: new Uint32Array(0) });
    h.network.setOptions({ colormap: (t) => [1 - t, t, 0.5], vertexBaseColor: [0.9, 0.8, 0.7, 1] });
    h.network.setChannel('vertexColor', new Float32Array([0, 0.5, 1]));
    h.network.setChannelDomain('vertexColor', [0.2, 0.8]);
    expect(h.network.getChannelDomain('vertexColor')).toEqual([0.2, 0.8]);
    h.network.setChannel('vertexColor', null);
    expect(h.network.getChannelDomain('vertexColor')).toBeNull();

    expect(h.renderer.setBorders).toHaveBeenCalledTimes(2);
    expect(h.renderer.writeColormap).toHaveBeenCalled();
    expectRgbaClose(h.loop.uniforms.vBaseColor, [0.9, 0.8, 0.7, 1]);
    expect(h.renderer.writeChannel).toHaveBeenCalledWith('vertexColor', expect.any(Float32Array));
    expect(h.loop.wake).toHaveBeenCalledTimes(5);
  });

  it('draws borders only over a geographic topology', async () => {
    const h = await makeHarness();
    expect(h.renderer.passes.borders).toBe(false);

    h.network.load(geographicTopology());
    expect(h.renderer.passes.borders).toBe(true);

    h.network.setOptions({ borders: false });
    expect(h.renderer.passes.borders).toBe(false);
    h.network.setOptions({ borders: true });
    expect(h.renderer.passes.borders).toBe(true);

    h.network.load(nonGlobeTopology());
    expect(h.renderer.passes.borders).toBe(false);
    h.network.load(ringTopology());
    expect(h.renderer.passes.borders).toBe(false);
  });

  it('applies programmatic selection and clearing without emitting select events', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const selects: Array<Item | null> = [];
    h.network.on('select', (item) => selects.push(item));

    h.network.select({ kind: 'vertex', index: 1 });
    h.network.select(null);

    expect(h.loop.uniforms.focus.vSelectedId).toBe(-1);
    expect(h.loop.uniforms.focus.eSelectedId).toBe(-1);
    expect(selects).toEqual([]);
  });

  it('routes pointer hover and tap intents through picker, focus, and events', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    const hovers: Array<Item | null> = [];
    const selects: Array<Item | null> = [];
    h.network.on('hover', (item) => hovers.push(item));
    h.network.on('select', (item) => selects.push(item));

    h.picker.nextHit = ['vertex', 1];
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    expect(hovers).toEqual([]);
    h.loop.paint();
    await flushMicrotasks();

    h.picker.nextHits = [['edge', 0]];
    h.emitPointer({ kind: 'tap', sx: 5, sy: 6, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(hovers).toEqual([{ kind: 'vertex', index: 1 }]);
    expect(selects).toEqual([{ kind: 'edge', index: 0 }]);
  });

  it('carries the pointer anchor and the hits with a pointer contextmenu', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const events: Events['contextmenu'][] = [];
    h.network.on('contextmenu', (payload) => events.push(payload));
    const event = new MouseEvent('contextmenu', { clientX: 5, clientY: 6 });
    h.picker.nextHits = [
      ['vertex', 2],
      ['edge', 0],
    ];

    h.emitPointer({ kind: 'contextmenu', event, keyboard: false });

    expect(events).toEqual([
      {
        event,
        keyboard: false,
        clientX: 5,
        clientY: 6,
        items: [
          { kind: 'vertex', index: 2 },
          { kind: 'edge', index: 0 },
        ],
      },
    ]);
    expect(h.picker.lastQuery).toMatchObject({ sx: 5, sy: 6, radiusPx: 10 });
    expect(h.loop.uniforms.focus.vSelectedId).toBe(-1);
    expect(h.loop.uniforms.focus.eSelectedId).toBe(-1);
  });

  it('anchors a keyboard contextmenu on the selection, clamped inside the canvas', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const events: Events['contextmenu'][] = [];
    h.network.on('contextmenu', (payload) => events.push(payload));
    const event = new MouseEvent('contextmenu');

    h.emitPointer({ kind: 'contextmenu', event, keyboard: true });
    expect(events[0]).toEqual({ event, keyboard: true, clientX: 50, clientY: 40, items: [] });

    h.network.select({ kind: 'edge', index: 1 });
    h.picker.nextLocation = [-30, 500];
    h.emitPointer({ kind: 'contextmenu', event, keyboard: true });
    expect(events[1]).toEqual({
      event,
      keyboard: true,
      clientX: 8,
      clientY: 72,
      items: [{ kind: 'edge', index: 1 }],
    });
    expect(h.picker.pickAll).not.toHaveBeenCalled();
  });

  it('hitTest maps client coordinates through current visibility without changing focus', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    vi.spyOn(h.surface, 'rect').mockReturnValue(new DOMRect(20, 30, 100, 80));
    h.network.setOptions({ vertices: false, poles: true });
    h.picker.nextHits = [
      ['vertex', 2],
      ['edge', 0],
    ];

    expect(h.network.hitTest(25, 36, 14)).toEqual([
      { kind: 'vertex', index: 2 },
      { kind: 'edge', index: 0 },
    ]);
    expect(h.picker.lastQuery).toEqual({
      sx: 5,
      sy: 6,
      radiusPx: 14,
      vp: { w: 100, h: 80 },
      vertices: false,
      edges: true,
      poles: true,
    });
    expect(h.loop.uniforms.focus.vSelectedId).toBe(-1);
    expect(h.loop.uniforms.focus.eSelectedId).toBe(-1);
  });

  it('hitTest defaults to the mouse radius and skips invalid or unavailable queries', async () => {
    const h = await makeHarness();

    expect(h.network.hitTest(5, 6)).toEqual([]);
    expect(h.picker.pickAll).not.toHaveBeenCalled();

    h.network.load(geographicTopology());
    h.picker.nextHits = [['edge', 0]];
    expect(h.network.hitTest(5, 6)).toEqual([{ kind: 'edge', index: 0 }]);
    expect(h.picker.lastQuery?.radiusPx).toBe(10);

    h.picker.pickAll.mockClear();
    expect(h.network.hitTest(-1, 6)).toEqual([]);
    expect(h.network.hitTest(Number.NaN, 6)).toEqual([]);
    expect(h.network.hitTest(5, 6, -1)).toEqual([]);
    expect(h.picker.pickAll).not.toHaveBeenCalled();

    h.network.detach();
    expect(h.network.hitTest(5, 6)).toEqual([]);
    expect(h.picker.pickAll).not.toHaveBeenCalled();
  });

  it('clamps hitTest radius to the viewport diagonal', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());

    h.network.hitTest(5, 6, 1_000_000);

    expect(h.picker.lastQuery?.radiusPx).toBeCloseTo(Math.hypot(100, 80));
  });

  it('locates items in client space without consulting display visibility', async () => {
    const h = await makeHarness();
    expect(h.network.locate({ kind: 'vertex', index: 2 })).toBeNull();
    expect(h.picker.locate).not.toHaveBeenCalled();

    h.network.load(geographicTopology());
    vi.spyOn(h.surface, 'rect').mockReturnValue(new DOMRect(20, 30, 100, 80));
    h.network.setOptions({ vertices: false, edges: false });
    h.picker.nextLocation = [5, 6];

    expect(h.network.locate({ kind: 'vertex', index: 2 })).toEqual([25, 36]);
    expect(h.picker.lastLocate).toEqual([['vertex', 2], { w: 100, h: 80 }]);
    expect(h.loop.uniforms.focus.vSelectedId).toBe(-1);
    expect(h.loop.uniforms.focus.eSelectedId).toBe(-1);
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
    expect(h.rig.fit).toHaveBeenCalledWith({ w: 100, h: 80 }, true);
  });

  it('routes keyboard intents through the public camera verbs and clears the selection', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const selects: Array<Item | null> = [];
    h.network.on('select', (item) => selects.push(item));

    h.emitKey({ kind: 'pan', dx: 48, dy: 0 });
    h.emitKey({ kind: 'rotate', dx: 0, dy: -48 });
    h.emitKey({ kind: 'zoom', factor: 1.2 });
    h.emitKey({ kind: 'fit' });
    h.emitKey({ kind: 'clear' });
    h.network.select({ kind: 'vertex', index: 1 });
    h.emitKey({ kind: 'clear' });

    expect(h.rig.camera.panBy).toHaveBeenCalledWith(48, 0, { w: 100, h: 80 });
    expect(h.rig.camera.rotateBy).toHaveBeenCalledWith(0, -48, { w: 100, h: 80 });
    expect(h.rig.camera.zoomAt).toHaveBeenCalledWith(1.2, 50, 40, { w: 100, h: 80 });
    expect(h.rig.fit).toHaveBeenCalledWith({ w: 100, h: 80 }, true);
    expect(selects).toEqual([null]);
    expect(h.loop.uniforms.focus.vSelectedId).toBe(-1);
  });

  it('attaches the keyboard map only while the option is on', async () => {
    const h = await makeHarness({ keyboard: false });
    expect(h.deps.attachKeyboard).not.toHaveBeenCalled();

    h.network.setOptions({ keyboard: true });
    expect(h.deps.attachKeyboard).toHaveBeenCalledOnce();

    h.network.setOptions({ keyboard: false });
    expect(h.keyboardCleanup.destroy).toHaveBeenCalledOnce();
    h.network.setOptions({ keyboard: true });
    expect(h.deps.attachKeyboard).toHaveBeenCalledTimes(2);
  });

  it('hands the pointer adapter a wheel policy that follows the live wheel option', async () => {
    const h = await makeHarness();
    const plain = new WheelEvent('wheel', { deltaY: 120 });
    const modified = new WheelEvent('wheel', { deltaY: 120, ctrlKey: true });

    expect(h.wheelPolicy?.(plain)).toBe('zoom');
    h.network.setOptions({ wheel: 'modifier' });
    expect(h.wheelPolicy?.(plain)).toBe('none');
    expect(h.wheelPolicy?.(modified)).toBe('zoom');
  });

  it('reduces motion by option: no animated fits, reveals, poses, coasts, or orbits', async () => {
    const h = await makeHarness({ motion: 'reduce' });
    h.network.load(geographicTopology());
    h.picker.nextLocation = [2, 40];
    h.picker.nextLocationVisible = true;

    h.network.fit(true);
    h.network.fit([{ kind: 'vertex', index: 1 }], true);
    h.network.reveal({ kind: 'vertex', index: 1 }, { animate: true });
    h.network.setPose({ bearing: 90 }, true);
    h.emitPointer({ kind: 'dragStart', sx: 1, sy: 2, vp: { w: 100, h: 80 }, time: 10 });
    h.emitPointer({ kind: 'dragEnd', coast: true, time: 30 });
    h.emitPointer({ kind: 'doubleTap', sx: 50, sy: 40, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(h.rig.fit.mock.calls.map((call) => call[1])).toEqual([false, false]);
    expect(h.rig.moveTo.mock.calls[0]?.[2]).toBe(false);
    expect(h.rig.reveal.mock.calls[0]?.[2]).toBe(false);
    expect(h.rig.camera.setPose).toHaveBeenCalledWith({ bearing: 90 }, false);
    expect(h.rig.camera.endDrag).toHaveBeenCalledWith(false, 30);
    expect(h.network.orbit(true)).toBe(false);
    expect(h.network.orbiting).toBe(false);

    h.network.setOptions({ motion: 'full' });
    h.network.fit(true);
    expect(h.rig.fit).toHaveBeenLastCalledWith({ w: 100, h: 80 }, true);
  });

  it('follows the reduced-motion preference under auto', async () => {
    const matches = vi.fn((_query: string) => true);
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return matches(query);
      },
    }));
    const h = await makeHarness();
    h.network.load(geographicTopology());

    h.network.fit(true);
    expect(matches).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(h.rig.fit).toHaveBeenLastCalledWith({ w: 100, h: 80 }, false);

    matches.mockReturnValue(false);
    h.network.fit(true);
    expect(h.rig.fit).toHaveBeenLastCalledWith({ w: 100, h: 80 }, true);
  });

  it('clears hover and selection from pointer exits and empty taps', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const hovers: Array<Item | null> = [];
    const selects: Array<Item | null> = [];
    h.network.on('hover', (item) => hovers.push(item));
    h.network.on('select', (item) => selects.push(item));

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

    expect(hovers).toEqual([{ kind: 'vertex', index: 1 }, null]);
    expect(selects).toEqual([null]);
  });

  it('clears only hover during navigation and restores it after the camera settles', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.network.select({ kind: 'vertex', index: 2 });
    h.picker.nextHit = ['edge', 0];
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();

    h.emitPointer({ kind: 'navigationStart' });
    expect(h.loop.uniforms.focus.eHoverId).toBe(-1);
    expect(h.loop.uniforms.focus.vSelectedId).toBe(2);

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
    h.rig.camera.rotateBy.mockReturnValue(false);
    h.rig.camera.zoomAt.mockReturnValue(false);

    h.network.panBy(0, 0);
    h.network.panBy(Number.NaN, 1);
    h.network.rotateBy(0, 0);
    h.network.rotateBy(1, Number.NaN);
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
    h.network.setOptions({ daylight: false, vertexBaseColor: [0.2, 0.3, 0.4, 1] });
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
    expect(h.rig.switchTo).toHaveBeenCalledWith('tilt', { w: 100, h: 80 });
    expect(h.loop.frameNow).toHaveBeenCalled();
  });

  it('coalesces fit notifications until paint and keeps fit listeners out of the render tick', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    let insidePaint = false;
    const notices: Array<{ atFit: boolean; insidePaint: boolean }> = [];
    let hoverNotices = 0;
    h.network.on('hover', () => hoverNotices++);
    h.network.on('fit', (atFit) => {
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
    expect(h.rig.switchTo).toHaveBeenCalledWith('tilt', { w: 100, h: 80 });
    expect(h.loop.frameNow).toHaveBeenCalled();
  });

  it('retains the physical hover probe and re-picks after a topology change', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    h.picker.pick.mockClear();

    h.network.load(nonGlobeTopology());
    h.loop.frame();

    expect(h.picker.pick).toHaveBeenCalledOnce();
  });

  it('cycles stacked tap hits after current vertex or edge selections', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const selects: Array<Item | null> = [];
    h.network.on('select', (item) => selects.push(item));

    h.picker.nextHits = [
      ['vertex', 1],
      ['edge', 0],
      ['edge', 1],
    ];
    h.network.select({ kind: 'vertex', index: 1 });
    h.emitPointer({ kind: 'tap', sx: 1, sy: 2, targetPx: 10, vp: { w: 100, h: 80 } });
    h.network.select({ kind: 'edge', index: 0 });
    h.emitPointer({ kind: 'tap', sx: 1, sy: 2, targetPx: 10, vp: { w: 100, h: 80 } });

    expect(selects).toEqual([
      { kind: 'edge', index: 0 },
      { kind: 'edge', index: 1 },
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

  it('warms supported inactive projections serially after first paint', async () => {
    const h = await makeHarness();
    const tilt = deferred<void>();
    h.renderer.warmProjection.mockImplementation((mode) =>
      mode === 'tilt' ? tilt.promise : Promise.resolve(),
    );
    h.network.load(geographicTopology());

    h.loop.paint();
    expect(h.renderer.warmProjection.mock.calls).toEqual([['tilt']]);

    tilt.resolve();
    await flushMicrotasks();
    expect(h.renderer.warmProjection.mock.calls).toEqual([['tilt'], ['globe']]);
    h.loop.paint();
    await flushMicrotasks();
    expect(h.renderer.warmProjection).toHaveBeenCalledTimes(2);
  });

  it('contains warm failures and continues with the next projection', async () => {
    const h = await makeHarness();
    const failure = new Error('warm failed');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pipelineError = vi.fn();
    h.network.on('pipelineError', pipelineError);
    h.renderer.warmProjection.mockImplementation((mode) =>
      mode === 'tilt' ? Promise.reject(failure) : Promise.resolve(),
    );
    h.network.load(geographicTopology());

    h.loop.paint();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(h.renderer.warmProjection.mock.calls).toEqual([['tilt'], ['globe']]);
    expect(error).toHaveBeenCalledWith(
      'network: failed to warm the tilt projection pipelines',
      failure,
    );
    // The renderer reports build failures through onPipelineError;
    // an unexpected warm rejection is only logged.
    expect(pipelineError).not.toHaveBeenCalled();
  });

  it('replays the latest asynchronous pipeline failure to late subscribers', async () => {
    const h = await makeHarness();
    const failure = new Error('pipeline failed');
    h.renderer.onPipelineError?.('globe', failure);

    const late = vi.fn();
    const unsubscribe = h.network.on('pipelineError', late);

    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith({ family: 'globe', cause: failure });
    unsubscribe();
  });

  it('warms projections that become available after a later load', async () => {
    const h = await makeHarness();
    h.network.load(nonGlobeTopology());

    h.loop.paint();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(h.renderer.warmProjection.mock.calls).toEqual([['tilt']]);

    h.network.load(geographicTopology());
    await flushMicrotasks();
    await flushMicrotasks();

    expect(h.renderer.warmProjection.mock.calls).toEqual([['tilt'], ['tilt'], ['globe']]);
  });

  it('fits, pans, rotates, poses, and zooms through the public camera methods', async () => {
    const h = await makeHarness();
    h.network.fit(true);
    h.network.panBy(1, 2);
    h.network.rotateBy(1, 2);
    h.network.zoomBy(2);
    expect(h.network.getPose()).toBeNull();
    expect(h.network.setPose({ centerX: 1 })).toBe(false);
    expect(h.rig.fit).not.toHaveBeenCalled();
    expect(h.rig.camera.panBy).not.toHaveBeenCalled();
    expect(h.rig.camera.rotateBy).not.toHaveBeenCalled();
    expect(h.rig.camera.zoomAt).not.toHaveBeenCalled();
    expect(h.rig.camera.setPose).not.toHaveBeenCalled();

    h.network.load(geographicTopology());
    h.network.fit(true);
    h.network.fit(false);
    h.network.panBy(3, 4);
    h.network.rotateBy(5, 6);
    h.network.zoomBy(1.25);

    expect(h.rig.fit).toHaveBeenNthCalledWith(1, { w: 100, h: 80 }, true);
    expect(h.rig.fit).toHaveBeenNthCalledWith(2, { w: 100, h: 80 }, false);
    expect(h.rig.camera.panBy).toHaveBeenCalledWith(3, 4, { w: 100, h: 80 });
    expect(h.rig.camera.rotateBy).toHaveBeenCalledWith(5, 6, { w: 100, h: 80 });
    expect(h.rig.camera.zoomAt).toHaveBeenCalledWith(1.25, 50, 40, { w: 100, h: 80 });

    expect(h.network.getPose()).toEqual({ centerX: 0, centerY: 0, pitch: 0, bearing: 0 });
    h.loop.wake.mockClear();
    expect(h.network.setPose({ bearing: 90 }, true)).toBe(true);
    expect(h.rig.camera.setPose).toHaveBeenCalledWith({ bearing: 90 }, true);
    expect(h.loop.wake).toHaveBeenCalled();
  });

  it('defers camera commands issued while detached to the rig', async () => {
    const h = await makeHarness({}, undefined, false);
    h.network.load(geographicTopology());

    h.network.fit(true);
    h.network.fit([{ kind: 'vertex', index: 1 }]);
    h.network.reveal({ kind: 'vertex', index: 1 });

    expect(h.rig.fit).toHaveBeenCalledWith({ w: 0, h: 0 }, true);
    expect(h.rig.moveTo.mock.calls[0]?.[1]).toEqual({ w: 0, h: 0 });
    expect(h.rig.reveal.mock.calls[0]?.[1]).toEqual({ w: 0, h: 0 });
  });

  it('fits valid item subsets without replacing whole-topology fit behavior', async () => {
    const h = await makeHarness();
    h.network.fit([{ kind: 'vertex', index: 1 }], true);
    expect(h.rig.moveTo).not.toHaveBeenCalled();

    h.network.load(geographicTopology());
    h.network.setOptions({ vertices: false, edges: false });
    h.rig.moveTo.mockClear();
    h.loop.wake.mockClear();
    h.surface.viewport = { w: 0, h: 80 };
    h.network.fit([{ kind: 'vertex', index: 1 }], true);

    // The rig owns the usable-viewport split; the controller always forwards.
    expect(h.rig.moveTo).toHaveBeenCalledOnce();
    expect(h.rig.moveTo.mock.calls[0]?.[1]).toEqual({ w: 0, h: 80 });
    expect(h.rig.moveTo.mock.calls[0]?.[2]).toBe(true);
    expect(h.loop.wake).toHaveBeenCalledOnce();

    h.surface.viewport = { w: 100, h: 80 };
    h.rig.moveTo.mockClear();
    h.loop.wake.mockClear();
    h.network.fit([], true);
    h.network.fit(
      [
        { kind: 'vertex', index: -1 },
        { kind: 'edge', index: 99 },
      ],
      true,
    );
    expect(h.rig.moveTo).not.toHaveBeenCalled();
    expect(h.loop.wake).not.toHaveBeenCalled();

    h.network.fit(
      [
        { kind: 'vertex', index: 1 },
        { kind: 'vertex', index: 1 },
      ],
      true,
    );

    expect(h.rig.moveTo).toHaveBeenCalledOnce();
    const [bounds, view, animate] = h.rig.moveTo.mock.calls[0]!;
    expect((bounds.xMin + bounds.xMax) / 2).toBeCloseTo(0);
    expect((bounds.yMin + bounds.yMax) / 2).toBeCloseTo(5);
    expect(bounds.xMax).toBeGreaterThan(bounds.xMin);
    expect(bounds.yMax).toBeGreaterThan(bounds.yMin);
    expect(view).toEqual({ w: 100, h: 80 });
    expect(animate).toBe(true);
    expect(h.loop.wake).toHaveBeenCalledOnce();

    h.rig.moveTo.mockClear();
    h.network.fit([{ kind: 'edge', index: 0 }]);
    expect(h.rig.moveTo.mock.calls[0]?.[2]).toBe(false);
  });

  it('reveals only items outside the padded visible viewport and preserves fit semantics', async () => {
    const h = await makeHarness();
    expect(h.network.reveal({ kind: 'vertex', index: 1 })).toBe(false);

    h.network.load(geographicTopology());
    h.network.setOptions({ revealPaddingPx: 8 });
    h.rig.claim.mockClear();
    h.loop.wake.mockClear();
    h.picker.nextLocation = [50, 40];
    h.picker.nextLocationVisible = true;

    expect(h.network.reveal({ kind: 'vertex', index: 1 })).toBe(true);
    expect(h.rig.reveal).not.toHaveBeenCalled();
    expect(h.rig.claim).toHaveBeenCalledOnce();
    expect(h.loop.wake).not.toHaveBeenCalled();

    h.picker.nextLocation = [2, 40];
    expect(h.network.reveal({ kind: 'vertex', index: 1 }, { animate: true })).toBe(true);
    expect(h.rig.reveal).toHaveBeenCalledOnce();
    const [bounds, view, animate] = h.rig.reveal.mock.calls[0]!;
    expect((bounds.xMin + bounds.xMax) / 2).toBeCloseTo(0);
    expect((bounds.yMin + bounds.yMax) / 2).toBeCloseTo(5);
    expect(view).toEqual({ w: 100, h: 80 });
    expect(animate).toBe(true);
    expect(h.rig.moveTo).not.toHaveBeenCalled();
    expect(h.loop.wake).toHaveBeenCalledOnce();
  });

  it('caps an oversized reveal padding to a usable central band', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.picker.nextLocationVisible = true;

    h.picker.nextLocation = [38, 40];
    expect(h.network.reveal({ kind: 'vertex', index: 1 })).toBe(true);
    expect(h.rig.reveal).toHaveBeenCalledOnce();

    h.rig.reveal.mockClear();
    h.network.setOptions({ revealPaddingPx: 10_000 });
    h.picker.nextLocation = [50, 40];
    expect(h.network.reveal({ kind: 'vertex', index: 1 })).toBe(true);
    expect(h.rig.reveal).not.toHaveBeenCalled();
  });

  it('lets an already-visible reveal supersede older camera motion', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.picker.nextLocation = [50, 40];
    h.picker.nextLocationVisible = true;
    h.rig.nextClaim = true;
    h.loop.wake.mockClear();

    expect(h.network.reveal({ kind: 'vertex', index: 1 })).toBe(true);

    expect(h.rig.claim).toHaveBeenCalledOnce();
    expect(h.rig.reveal).not.toHaveBeenCalled();
    expect(h.loop.wake).toHaveBeenCalledOnce();
  });

  it('centers occluded items and forwards hidden viewports', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.picker.nextLocation = [50, 40];
    h.picker.nextLocationVisible = false;

    expect(h.network.reveal({ kind: 'edge', index: 0 })).toBe(true);
    expect(h.rig.reveal).toHaveBeenCalledOnce();

    // The rig owns unusable-viewport deferral; the controller forwards as-is.
    h.rig.reveal.mockClear();
    h.surface.viewport = { w: 0, h: 80 };
    expect(h.network.reveal({ kind: 'vertex', index: 1 }, { animate: true })).toBe(true);
    expect(h.rig.reveal).toHaveBeenCalledOnce();
    expect(h.rig.reveal.mock.calls[0]?.[1]).toEqual({ w: 0, h: 80 });
    expect(h.rig.reveal.mock.calls[0]?.[2]).toBe(true);

    h.surface.viewport = { w: 100, h: 80 };
    expect(h.network.reveal({ kind: 'vertex', index: 99 })).toBe(false);
  });

  it('anchors globe item bounds at the camera longitude when center unprojection misses', async () => {
    const h = await makeHarness();
    h.network.load({
      vertexCount: 2,
      vertexCoords: new Float32Array([-179, 0, 179, 1]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 0]),
    });
    h.rig.mode = 'globe';
    h.rig.camera.pose.mockReturnValue({ centerX: 170, centerY: 0, pitch: 0, bearing: 0 });
    h.rig.camera.screenToWorld.mockReturnValue(null);

    h.network.fit([{ kind: 'vertex', index: 0 }]);

    const bounds = h.rig.moveTo.mock.calls[0]?.[0];
    expect(bounds && (bounds.xMin + bounds.xMax) / 2).toBeCloseTo(181);

    h.picker.nextLocation = [50, 40];
    h.picker.nextLocationVisible = false;
    h.network.reveal({ kind: 'vertex', index: 0 });
    const revealBounds = h.rig.reveal.mock.calls[0]?.[0];
    expect(revealBounds && (revealBounds.xMin + revealBounds.xMax) / 2).toBeCloseTo(181);
  });

  it('falls back through the canonical projection order only when asked', async () => {
    const h = await makeHarness();
    h.network.load(nonGlobeTopology());
    h.network.setProjection('tilt');

    expect(h.network.setProjection('globe')).toBe(false);
    expect(h.network.projection).toBe('tilt');
    expect(h.network.setProjection('globe', true)).toBe(false);
    expect(h.network.projection).toBe('flat');
    expect(h.network.setProjection('tilt', true)).toBe(true);
    expect(h.network.projection).toBe('tilt');
  });

  it('answers neighborhoods from a per-topology adjacency', async () => {
    const h = await makeHarness();
    expect(h.network.neighborhood({ kind: 'vertex', index: 0 })).toEqual([]);

    h.network.load(geographicTopology());
    expect(h.network.neighborhood({ kind: 'edge', index: 0 })).toEqual([
      { kind: 'edge', index: 0 },
      { kind: 'vertex', index: 0 },
      { kind: 'vertex', index: 1 },
    ]);
    const first = h.network.neighborhood({ kind: 'vertex', index: 1 });
    expect(first.length).toBeGreaterThan(1);
    expect(h.network.neighborhood({ kind: 'vertex', index: 1 })).toEqual(first);
  });

  it('reveals a populated neighborhood by fitting it and a lone item like any other', async () => {
    const h = await makeHarness();
    h.network.load({
      vertexCount: 3,
      vertexCoords: new Float32Array([-10, -5, 10, 5, 0, 0]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 0]),
    });
    h.picker.nextLocation = [50, 40];
    h.picker.nextLocationVisible = true;

    expect(h.network.reveal({ kind: 'vertex', index: 0 }, { neighbors: true, animate: true })).toBe(
      true,
    );
    expect(h.rig.moveTo).toHaveBeenCalledOnce();
    expect(h.rig.moveTo.mock.calls[0]?.[2]).toBe(true);
    expect(h.rig.reveal).not.toHaveBeenCalled();

    // A lone item is already inside the inset: left in place, never fitted or centered.
    expect(h.network.reveal({ kind: 'vertex', index: 2 }, { neighbors: true })).toBe(true);
    expect(h.rig.moveTo).toHaveBeenCalledOnce();
    expect(h.rig.reveal).not.toHaveBeenCalled();

    h.picker.nextLocationVisible = false;
    expect(h.network.reveal({ kind: 'vertex', index: 2 }, { neighbors: true })).toBe(true);
    expect(h.rig.moveTo).toHaveBeenCalledOnce();
    expect(h.rig.reveal).toHaveBeenCalledOnce();
    expect(h.rig.reveal.mock.calls[0]?.[2]).toBe(false);
  });

  it('orbits through the internal driver, reports transitions, and stops on gestures', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const h = await makeHarness();
    const transitions: boolean[] = [];
    h.network.on('orbit', (active) => transitions.push(active));

    expect(h.network.orbit(true)).toBe(false);
    expect(h.network.orbiting).toBe(false);

    h.network.load(geographicTopology());
    expect(h.network.orbit(true)).toBe(true);
    expect(h.network.orbiting).toBe(true);
    expect(h.network.projection).toBe('tilt');
    expect(h.network.orbit(true)).toBe(true);
    frames.shift()?.(0);
    frames.shift()?.(16);
    expect(h.rig.camera.rotateBy).toHaveBeenLastCalledWith(0.32, 0, { w: 100, h: 80 });

    h.emitPointer({ kind: 'navigationStart' });
    expect(h.network.orbiting).toBe(false);
    expect(transitions).toEqual([true, false]);

    expect(h.network.orbit(true)).toBe(true);
    h.emitKey({ kind: 'zoom', factor: 1.2 });
    expect(h.network.orbiting).toBe(false);

    expect(h.network.orbit(true)).toBe(true);
    expect(h.network.orbit(false)).toBe(false);
    expect(transitions).toEqual([true, false, true, false, true, false]);

    h.network.orbit(true);
    h.network.load(nonGlobeTopology());
    expect(h.network.orbiting).toBe(true);
    h.network.detach();
    expect(h.network.orbiting).toBe(false);
  });

  it('applies the height range option through channel scalars', async () => {
    const h = await makeHarness({ heightRange: [1, 3] });
    h.network.load(geographicTopology());
    h.network.setChannel('vertexHeight', new Float32Array([0, 1, 2]));
    expect(h.loop.uniforms.channel.vHeightOutMin).toBe(1);
    expect(h.loop.uniforms.channel.vHeightOutSpan).toBe(2);

    h.picker.pick.mockClear();
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    h.picker.pick.mockClear();
    h.network.setOptions({ heightRange: [0, 4] });
    expect(h.loop.uniforms.channel.vHeightOutSpan).toBe(4);
    h.loop.frame();
    expect(h.picker.pick).toHaveBeenCalledOnce();
  });

  it('keeps render-loop activity in sync with pause, resume, and page visibility', async () => {
    const h = await makeHarness();
    const hidden = vi.spyOn(document, 'hidden', 'get');
    // Attaching a visible, unpaused controller starts the loop once.
    expect(h.loop.resume).toHaveBeenCalledOnce();
    expect(h.loop.pause).not.toHaveBeenCalled();

    h.network.pause();
    expect(h.loop.pause).toHaveBeenCalledOnce();
    h.network.resume();
    expect(h.loop.resume).toHaveBeenCalledTimes(2);

    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.loop.pause).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.loop.resume).toHaveBeenCalledTimes(3);

    // A consumer pause survives detach and holds the next binding's loop.
    h.network.pause();
    h.network.detach();
    h.loop.pause.mockClear();
    h.loop.resume.mockClear();
    await h.network.attach(h.canvas);
    expect(h.loop.pause).toHaveBeenCalledOnce();
    expect(h.loop.resume).not.toHaveBeenCalled();
  });

  it('arms the daylight wake timer only while shading is on and the topology is geographic', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    h.loop.wake.mockClear();

    // No topology: the geographic gate holds the idle wake.
    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).not.toHaveBeenCalled();

    // Geographic data wakes in every projection family (mode stays flat).
    h.network.load(geographicTopology());
    h.loop.wake.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).toHaveBeenCalledOnce();

    // Generated ring layouts stay abstract despite in-range bounds.
    h.network.load(ringTopology());
    h.loop.wake.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).not.toHaveBeenCalled();

    h.network.load(geographicTopology());
    h.network.setOptions({ daylight: false });
    h.loop.wake.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).not.toHaveBeenCalled();

    h.network.setOptions({ daylight: true });
    h.network.detach();
    h.loop.wake.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).not.toHaveBeenCalled();
  });

  it('pins the sun to sunTime, refreshes it at once, and disarms the wake timer while pinned', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    h.network.load(geographicTopology());
    const noon = Date.UTC(2026, 5, 21, 12);
    const midnight = Date.UTC(2026, 5, 21, 0);

    h.network.setOptions({ sunTime: noon });
    const pinned = [...h.loop.uniforms.rawF32.subarray(20, 23)];
    h.loop.frame();
    expect([...h.loop.uniforms.rawF32.subarray(20, 23)]).toEqual(pinned);

    // A pinned sun never moves, so the idle wake has nothing to refresh.
    h.loop.wake.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).not.toHaveBeenCalled();

    // A new instant lands without waiting for the refresh cadence.
    h.network.setOptions({ sunTime: midnight });
    expect([...h.loop.uniforms.rawF32.subarray(20, 23)]).not.toEqual(pinned);

    h.network.setOptions({ sunTime: null });
    h.loop.wake.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(h.loop.wake).toHaveBeenCalledOnce();
  });

  it('paints edges in edgeBaseColor only while one is set', async () => {
    const h = await makeHarness();
    expect(h.loop.uniforms.display.flags & DISPLAY_EDGE_BASE_COLOR).toBe(0);

    h.network.setOptions({ edgeBaseColor: [0.1, 0.2, 0.3, 1] });
    expect(h.loop.uniforms.display.flags & DISPLAY_EDGE_BASE_COLOR).toBe(DISPLAY_EDGE_BASE_COLOR);
    expect([...h.loop.uniforms.eBaseColor]).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
      1,
    ]);

    h.network.setOptions({ edgeBaseColor: null });
    expect(h.loop.uniforms.display.flags & DISPLAY_EDGE_BASE_COLOR).toBe(0);
  });

  it('tells the edge shader whether vertex discs are drawn, so edges end at them', async () => {
    const h = await makeHarness();
    expect(h.loop.uniforms.display.flags & DISPLAY_VERTICES).toBe(DISPLAY_VERTICES);

    h.network.setOptions({ vertices: false });
    expect(h.loop.uniforms.display.flags & DISPLAY_VERTICES).toBe(0);
    expect(h.renderer.passes.vertices).toBe(false);

    h.network.setOptions({ vertices: true });
    expect(h.loop.uniforms.display.flags & DISPLAY_VERTICES).toBe(DISPLAY_VERTICES);
  });

  it('maps the vertexSize channel onto the live sizeRange and pads picking by its maximum', async () => {
    const h = await makeHarness({ sizeRange: [1, 3] });
    expect(h.loop.uniforms.channel.vSizeOutMin).toBe(1);
    expect(h.loop.uniforms.channel.vSizeOutSpan).toBe(2);

    h.network.load(geographicTopology());
    h.network.setChannel('vertexSize', new Float32Array([0, 1, 2]));
    h.emitPointer({ kind: 'hover', clientX: 5, clientY: 6, targetPx: 10 });
    h.loop.frame();
    h.picker.pick.mockClear();

    h.network.setOptions({ sizeRange: [0.25, 0.75] });
    expect(h.loop.uniforms.channel.vSizeOutMin).toBe(0.25);
    expect(h.loop.uniforms.channel.vSizeOutSpan).toBe(0.5);
    h.loop.frame();
    expect(h.picker.pick).toHaveBeenCalledOnce();
  });

  it('hands the live pick radius to the pointer adapter and hitTest', async () => {
    const h = await makeHarness({ pickRadiusPx: 4 });
    h.network.load(geographicTopology());
    expect(h.pickRadiusPx?.()).toBe(4);

    h.network.hitTest(5, 6);
    expect(h.picker.lastQuery?.radiusPx).toBe(4);

    h.network.setOptions({ pickRadiusPx: 12 });
    expect(h.pickRadiusPx?.()).toBe(12);
    h.network.hitTest(5, 6);
    expect(h.picker.lastQuery?.radiusPx).toBe(12);
  });

  it('scales continuous rotation by orbitRate and hands animationMs to the rig', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const h = await makeHarness({ orbitRate: 2, animationMs: 250 });
    expect(h.rig.animationMs).toBe(250);
    h.network.load(geographicTopology());

    expect(h.network.orbit(true)).toBe(true);
    frames.shift()?.(0);
    frames.shift()?.(16);
    expect(h.rig.camera.rotateBy).toHaveBeenLastCalledWith(0.64, 0, { w: 100, h: 80 });

    h.network.setOptions({ orbitRate: 0.5, animationMs: 0 });
    frames.shift()?.(32);
    expect(h.rig.camera.rotateBy).toHaveBeenLastCalledWith(0.16, 0, { w: 100, h: 80 });
    expect(h.rig.animationMs).toBe(0);
  });

  it('arms DISPLAY_DAYLIGHT only for geographic topologies', async () => {
    const h = await makeHarness();
    expect(h.loop.uniforms.display.flags & DISPLAY_DAYLIGHT).toBe(0);

    h.network.load(geographicTopology());
    expect(h.loop.uniforms.display.flags & DISPLAY_DAYLIGHT).toBe(DISPLAY_DAYLIGHT);

    // Coordinates outside lon/lat ranges disarm shading despite the option.
    h.network.load(nonGlobeTopology());
    expect(h.loop.uniforms.display.flags & DISPLAY_DAYLIGHT).toBe(0);

    h.network.load(geographicTopology());
    h.network.setOptions({ daylight: false });
    expect(h.loop.uniforms.display.flags & DISPLAY_DAYLIGHT).toBe(0);
  });

  it('arms DISPLAY_GEOGRAPHIC for geographic topologies regardless of daylight', async () => {
    const h = await makeHarness();
    expect(h.loop.uniforms.display.flags & DISPLAY_GEOGRAPHIC).toBe(0);

    // The plane background clips its ground to the lon/lat world rect on
    // this bit alone; the daylight toggle must not disturb it.
    h.network.load(geographicTopology());
    expect(h.loop.uniforms.display.flags & DISPLAY_GEOGRAPHIC).toBe(DISPLAY_GEOGRAPHIC);
    h.network.setOptions({ daylight: false });
    expect(h.loop.uniforms.display.flags & DISPLAY_GEOGRAPHIC).toBe(DISPLAY_GEOGRAPHIC);

    // Abstract coordinates keep the unbounded plane.
    h.network.load(nonGlobeTopology());
    expect(h.loop.uniforms.display.flags & DISPLAY_GEOGRAPHIC).toBe(0);
  });

  it('never reads generated layouts as geographic', async () => {
    const h = await makeHarness();

    // The ring fallback's bounds fit the lon/lat box, but interpretation
    // requires caller-supplied coordinates.
    h.network.load(ringTopology());
    expect(h.network.geographic).toBe(false);
    expect(h.network.projections.globe).toBe(false);
    expect(h.loop.uniforms.display.flags & (DISPLAY_DAYLIGHT | DISPLAY_GEOGRAPHIC)).toBe(0);

    // An empty coordinate array also resolves to the generated ring.
    h.network.load({ ...ringTopology(), vertexCoords: new Float32Array(0) });
    expect(h.network.geographic).toBe(false);
    expect(h.network.projections.globe).toBe(false);
    expect(h.loop.uniforms.display.flags & (DISPLAY_DAYLIGHT | DISPLAY_GEOGRAPHIC)).toBe(0);

    // A declaration cannot turn generated coordinates into geographic data.
    h.network.load({ ...ringTopology(), coordinateSpace: 'geographic' });
    expect(h.network.geographic).toBe(false);
    expect(h.network.projections.globe).toBe(false);
    expect(h.loop.uniforms.display.flags & (DISPLAY_DAYLIGHT | DISPLAY_GEOGRAPHIC)).toBe(0);
  });

  it('honors coordinate declarations without bypassing geographic bounds', async () => {
    const h = await makeHarness();

    h.network.load({ ...geographicTopology(), coordinateSpace: 'cartesian' });
    expect(h.network.geographic).toBe(false);
    expect(h.network.projections.globe).toBe(false);
    expect(h.loop.uniforms.display.flags & (DISPLAY_DAYLIGHT | DISPLAY_GEOGRAPHIC)).toBe(0);

    h.network.load({ ...geographicTopology(), coordinateSpace: 'geographic' });
    expect(h.network.geographic).toBe(true);
    expect(h.network.projections.globe).toBe(true);

    h.network.load({ ...nonGlobeTopology(), coordinateSpace: 'geographic' });
    expect(h.network.geographic).toBe(false);
    expect(h.network.projections.globe).toBe(false);
    expect(h.loop.uniforms.display.flags & (DISPLAY_DAYLIGHT | DISPLAY_GEOGRAPHIC)).toBe(0);
  });

  it('exposes geographic interpretation for the loaded topology', async () => {
    const h = await makeHarness();
    expect(h.network.geographic).toBe(false);

    h.network.load(geographicTopology());
    expect(h.network.geographic).toBe(true);

    h.network.load(nonGlobeTopology());
    expect(h.network.geographic).toBe(false);
  });

  it('updates globe height scale during frame hooks', async () => {
    const h = await makeHarness();
    h.network.load(geographicTopology());
    h.rig.mode = 'globe';

    h.loop.frame({ w: 200, h: 100 });

    expect(h.loop.uniforms.geometry.heightAmplitude).toBeCloseTo(VISUAL.globeHeightRadialScale, 6);
  });

  it('idempotently destroys owned collaborators and returns the lease', async () => {
    const h = await makeHarness();
    h.presentation.resize(800, 450);
    h.network.load(geographicTopology());
    h.network.setChannel('vertexVisible', new Float32Array([1, 0, 1]));

    h.network.destroy();
    h.network.destroy();

    expect(h.deps.createPresentation).toHaveBeenCalledWith(h.device, h.canvas);
    expect(h.loop.destroy).toHaveBeenCalledOnce();
    expect(h.pointerCleanup.destroy).toHaveBeenCalledOnce();
    expect(h.renderer.destroy).toHaveBeenCalledOnce();
    expect(h.presentation.destroy).toHaveBeenCalledOnce();
    expect(h.surface.destroy).toHaveBeenCalledOnce();
    expect(h.pool.releases).toHaveBeenCalledOnce();
    expect(h.picker.commitScene).toHaveBeenLastCalledWith(null);
    expect(h.picker.deps?.values('vertexVisible')).toBeNull();
    expect(h.canvas.isConnected).toBe(true);
    expect(h.canvas.getAttribute('width')).toBe('320');
    expect(h.canvas.getAttribute('height')).toBe('180');
    expect(h.canvas.style.opacity).toBe('');
    expect(h.pool.devices[0]!.destroy).not.toHaveBeenCalled();
    expect(h.network.attached).toBe(false);
    expect(h.events.attached).toEqual([true]);
  });
});
