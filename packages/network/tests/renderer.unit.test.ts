/// <reference types="@webgpu/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Renderer } from '../src/webgpu/renderer.js';
import { encodeTopology, type Topology } from '../src/topology/index.js';
import { encodeSegments } from '../src/segments/index.js';
import { prepareScene, type PreparedScene } from '../src/scene.js';
import {
  createUniforms,
  FOCUS_ENABLED,
  FOCUS_HOVER_ENDPOINTS,
  FOCUS_SELECTED_ENDPOINTS,
  DISPLAY_GRATICULE,
} from '../src/webgpu/uniforms.js';
import { BORDER_VERTEX_STRIDE_BYTES } from '../src/borders/index.js';
import { sampleTopology, singleEdgeTopology } from './fixtures/topology.js';
import { flushGpuPromises, installWebGpuConstants, makeFakeGpu } from './fixtures/fake-webgpu.js';

beforeEach(() => {
  installWebGpuConstants();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function preparedScene(topology: Topology): PreparedScene {
  return prepareScene(encodeTopology(topology), encodeSegments(topology));
}

describe('Renderer resource lifecycle', () => {
  it('allocates shared GPU resources and builds the initial projection pipeline', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, 1);

    await flushGpuPromises();

    expect(h.device.buffers.map((buffer) => buffer.descriptor.label)).toEqual([
      'unit-quad',
      'edge-strip',
      'uniforms',
      'shade-host',
    ]);
    expect(h.device.textures.map((texture) => texture.descriptor.label)).toEqual(['colormap-lut']);
    expect(h.device.queue.writeTexture).toHaveBeenCalledOnce();
    expect(h.device.renderPipelines.map((pipeline) => pipeline.label)).toContain(
      'plane-background',
    );

    renderer.destroy();
    expect(h.device.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(h.device.textures.every((texture) => texture.destroyed)).toBe(true);
  });

  it('dispatches complete plane and globe bundles before awaiting compilation', async () => {
    const h = makeFakeGpu();
    let release!: (pipeline: GPURenderPipeline) => void;
    const pending = new Promise<GPURenderPipeline>((resolve) => {
      release = resolve;
    });
    h.device.createRenderPipelineAsync.mockReturnValue(pending);

    const renderer = new Renderer(h.presentation, 1);
    const labels = (): string[] =>
      h.device.createRenderPipelineAsync.mock.calls.map(([descriptor]) => descriptor.label ?? '');

    // The shared planar family has nine; globe adds earth-axis for ten.
    expect(labels().filter((label) => label.startsWith('plane-'))).toHaveLength(9);
    renderer.useProjection('tilt');
    void renderer.warmProjection('flat');
    expect(labels().filter((label) => label.startsWith('plane-'))).toHaveLength(9);
    void renderer.warmProjection('globe');
    expect(labels().filter((label) => label.startsWith('globe-'))).toHaveLength(10);

    release({ label: 'compiled' } as GPURenderPipeline);
    await flushGpuPromises();
    renderer.destroy();
  });

  it('selects 1x pipelines by default on huge device-pixel screens', async () => {
    vi.stubGlobal('screen', { width: 4000, height: 2400 });
    vi.stubGlobal('devicePixelRatio', 1);
    const h = makeFakeGpu();

    const renderer = new Renderer(h.presentation);
    await flushGpuPromises();

    expect(h.device.renderPipelines[0]?.multisample?.count).toBe(1);
    renderer.destroy();
  });

  it("uses the canvas window's display for automatic multisampling", async () => {
    vi.stubGlobal('screen', { width: 100, height: 100 });
    vi.stubGlobal('devicePixelRatio', 1);
    const h = makeFakeGpu();
    Object.assign(h.canvas, {
      ownerDocument: {
        defaultView: {
          screen: { width: 2000, height: 1000 },
          devicePixelRatio: 2,
        },
      },
    });

    const renderer = new Renderer(h.presentation);
    await flushGpuPromises();

    expect(h.device.renderPipelines[0]?.multisample?.count).toBe(1);
    renderer.destroy();
  });

  it('dedupes warmed projection builds and wakes when they are ready', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const ready = vi.fn();
    renderer.onPipelinesReady = ready;

    await flushGpuPromises();
    ready.mockClear();

    const first = renderer.warmProjection('globe');
    const second = renderer.warmProjection('globe');
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(ready).toHaveBeenCalledOnce();
    expect(
      h.device.renderPipelines.filter((pipeline) => pipeline.label === 'globe-background'),
    ).toHaveLength(1);
    renderer.destroy();
  });

  it('logs projection build failures without throwing out of construction', async () => {
    const h = makeFakeGpu();
    const failure = new Error('shader no good');
    h.device.createRenderPipelineAsync.mockRejectedValueOnce(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const renderer = new Renderer(h.presentation);
    const reported = vi.fn();
    renderer.onPipelineError = reported;
    await flushGpuPromises();
    const calls = h.device.createRenderPipelineAsync.mock.calls.length;
    await renderer.warmProjection('flat');

    expect(error).toHaveBeenCalledWith(
      'network: failed to build the plane projection pipelines',
      expect.any(Error),
    );
    expect(reported).toHaveBeenCalledWith('plane', expect.any(Error));
    expect((reported.mock.calls[0]![1] as Error).cause).toBe(failure);
    expect(h.device.createRenderPipelineAsync).toHaveBeenCalledTimes(calls);
    renderer.destroy();
  });

  it('allocates every channel slot with the topology and writes channels in place', () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    // 3 vertices, 2 edges: 5 scalar vertex channels, 4 edge channels, one vec2 position channel.
    const topology = sampleTopology();

    renderer.bindTopology(preparedScene(topology));
    const channelBuffer = h.device.buffers.find(
      (buffer) => buffer.descriptor.label === 'channels',
    )!;
    expect(channelBuffer.descriptor.size).toBe((5 * 3 + 4 * 2 + 2 * 3) * 4);

    const dashes = new Float32Array([1, 0]);
    renderer.writeChannel('edgeDash', dashes);
    // vertexColor, vertexHeight, vertexSize (3 each), edgeColor (2) precede edgeDash.
    expect(h.device.queue.writeBuffer).toHaveBeenLastCalledWith(
      expect.anything(),
      (3 * 3 + 2) * 4,
      dashes.buffer,
      dashes.byteOffset,
      dashes.byteLength,
    );

    const colors = new Float32Array([0, 0.5, 1]);
    renderer.writeChannel('vertexColor', colors);
    expect(h.device.queue.writeBuffer).toHaveBeenLastCalledWith(
      expect.anything(),
      0,
      colors.buffer,
      colors.byteOffset,
      colors.byteLength,
    );
    expect(
      h.device.buffers.filter((buffer) => buffer.descriptor.label === 'channels'),
    ).toHaveLength(1);
    expect(channelBuffer.destroyed).toBe(false);

    renderer.destroy();
  });

  it('checks channel storage against the device limits when the topology binds', () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const fits = vi.spyOn(
      renderer as unknown as { assertStorageBufferFits(label: string, bytes: number): void },
      'assertStorageBufferFits',
    );

    renderer.bindTopology(preparedScene(sampleTopology())); // channel storage needs 116 bytes

    expect(fits.mock.calls.map(([label, bytes]) => [label, bytes])).toContainEqual([
      'channel',
      116,
    ]);
    renderer.destroy();
  });

  it('cleans partially allocated topology resources when a later allocation fails', () => {
    const h = makeFakeGpu();
    h.device.failBufferLabels.add('network-segments');
    const renderer = new Renderer(h.presentation);
    const topology = singleEdgeTopology();

    expect(() => renderer.bindTopology(preparedScene(topology))).toThrow(
      'failed buffer network-segments',
    );

    expect(
      h.device.buffers.find((buffer) => buffer.descriptor.label === 'network-topology')?.destroyed,
    ).toBe(true);
    expect(() => renderer.writeChannel('vertexColor', new Float32Array([1, 2]))).toThrow(
      'network channel vertexColor has no storage slot',
    );
    renderer.destroy();
  });

  it('checks both WebGPU storage and total buffer limits', () => {
    const h = makeFakeGpu({ limits: { maxBufferSize: 4, maxStorageBufferBindingSize: 4096 } });
    const renderer = new Renderer(h.presentation);
    const topology = singleEdgeTopology();

    expect(() => renderer.bindTopology(preparedScene(topology))).toThrow(
      'exceeds WebGPU buffer size limit',
    );
    renderer.destroy();
  });

  it('replaces and clears optional border buffers', () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const borders = {
      vertices: new Uint8Array(BORDER_VERTEX_STRIDE_BYTES),
      indices: new Uint32Array([0]),
    };

    renderer.setBorders(borders);
    const borderBuffer = h.device.buffers.find((buffer) => buffer.descriptor.label === 'borders');
    renderer.setBorders(null);

    expect(borderBuffer?.destroyed).toBe(true);
    renderer.destroy();
  });
});

describe('Renderer frame encoding', () => {
  it('skips rendering until both topology and active pipelines are ready', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const topology = sampleTopology();
    renderer.bindTopology(preparedScene(topology));

    expect(renderer.render(createUniforms())).toBe(false);

    await flushGpuPromises();
    expect(renderer.render(createUniforms())).toBe(true);
    expect(h.device.queue.submit).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it('submits a flat graticule frame with focused edge and vertex overlays', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, 1);
    const topology = sampleTopology();
    renderer.bindTopology(preparedScene(topology));
    await flushGpuPromises();

    const uniforms = createUniforms();
    uniforms.display.flags = DISPLAY_GRATICULE;
    uniforms.focus.flags = FOCUS_ENABLED | FOCUS_HOVER_ENDPOINTS | FOCUS_SELECTED_ENDPOINTS;
    uniforms.focus.vHoverId = 2;
    uniforms.focus.vSelectedId = 2;
    uniforms.focus.eHoverId = 1;
    uniforms.focus.eSelectedId = 1;
    uniforms.focus.setEndpoints(0, 2, 1, 2);

    expect(renderer.render(uniforms)).toBe(true);

    const pass = h.device.encoders[0]!.passes[0]!;
    expect(pass.setPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'plane-background' }) as GPURenderPipeline,
    );
    expect(pass.draw).toHaveBeenCalledWith(4, 4);
    expect(pass.draw).toHaveBeenCalledWith(4, 3, 0, 1);
    expect(pass.draw).toHaveBeenCalledWith(4, 1, 0, 2);
    expect(pass.draw).toHaveBeenCalledWith(4, 1, 0, 0);
    expect(pass.draw).toHaveBeenCalledWith(4, 1, 0, 1);
    expect(h.device.queue.writeBuffer.mock.calls.some((call) => call[2] === uniforms.raw)).toBe(
      true,
    );
    renderer.destroy();
  });

  it('warns once when a focused edge has no segment range', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const topology = sampleTopology();
    renderer.bindTopology(preparedScene(topology));
    await flushGpuPromises();
    (renderer as unknown as { edgeSegStart: Uint32Array }).edgeSegStart = new Uint32Array([
      0, 0, 4,
    ]);

    const uniforms = createUniforms();
    uniforms.focus.flags = FOCUS_ENABLED;
    uniforms.focus.eHoverId = 0;

    renderer.render(uniforms);
    renderer.render(uniforms);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'network: focused edge 0 has an empty segment range; base rendering remains active',
    );
    renderer.destroy();
  });

  it('renders height poles only for non-flat projections with height channels', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const topology = sampleTopology();
    renderer.bindTopology(preparedScene(topology));
    renderer.useProjection('tilt');
    await flushGpuPromises();

    const uniforms = createUniforms();
    uniforms.channel.vHeightMode = 1;
    uniforms.camera.depthMix = 1;
    renderer.setPasses({ poles: true });

    expect(renderer.render(uniforms)).toBe(true);

    const labels = h.device.encoders[0]!.passes[0]!.calls.filter(
      (call) => call.method === 'setPipeline',
    ).map((call) => (call.args[0] as { label?: string }).label);
    expect(labels).toContain('plane-pole');
    renderer.destroy();
  });
});

describe('Renderer shade', () => {
  const custom = 'fn shade(f: Fragment) -> vec4f { return f.color * 2.0; }';

  it('compiles the host shade into the vertex and edge modules and uploads the host block', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, 1, custom);
    await flushGpuPromises();

    const code = (label: string): string =>
      h.device.shaderModules.find((module) => module.label === label)!.code;
    expect(code('vert')).toContain('struct Fragment');
    expect(code('vert')).toContain('return f.color * 2.0;');
    expect(code('edge')).toContain('return f.color * 2.0;');
    expect(code('edge')).toContain('fn edge_shade_val');
    expect(code('pole')).not.toContain('struct Fragment');
    expect(
      [...h.device.bindGroupLayouts[0]!.entries].some(
        (entry) => entry.binding === 4 && entry.visibility === GPUShaderStage.FRAGMENT,
      ),
    ).toBe(true);

    renderer.bindTopology(preparedScene(sampleTopology()));
    const uniforms = createUniforms();
    uniforms.host[0] = 7;
    expect(renderer.render(uniforms)).toBe(true);
    const host = h.device.buffers.find((buffer) => buffer.descriptor.label === 'shade-host');
    expect(host?.descriptor.size).toBe(256);
    expect(h.device.queue.writeBuffer).toHaveBeenCalledWith(host, 0, uniforms.host);
    renderer.destroy();
    expect(host?.destroyed).toBe(true);
  });

  it('swaps in a new shade once its pipelines land and drops other families to rebuild lazily', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, 1);
    const ready = vi.fn();
    renderer.onPipelinesReady = ready;
    await flushGpuPromises();
    await renderer.warmProjection('globe');
    ready.mockClear();
    const before = h.device.renderPipelines.length;

    await renderer.setShade(custom);
    expect(ready).toHaveBeenCalledOnce();
    expect(h.device.renderPipelines.length - before).toBe(9);
    const latest = (label: string): string =>
      h.device.shaderModules.filter((module) => module.label === label).at(-1)!.code;
    expect(latest('vert')).toContain('return f.color * 2.0;');

    // The globe family was compiled against the old shade and rebuilds on demand.
    await renderer.warmProjection('globe');
    expect(h.device.renderPipelines.length - before).toBe(19);
    expect(latest('vert')).toContain('return f.color * 2.0;');

    // An unchanged shade builds nothing; null is the identity shade.
    await renderer.setShade(custom);
    expect(h.device.renderPipelines.length - before).toBe(19);
    await renderer.setShade(null);
    expect(h.device.renderPipelines.length - before).toBe(28);
    expect(latest('vert')).toContain('return f.color;');
    renderer.destroy();
  });

  it('rejects a shade that fails to compile, names the failure, and keeps the previous shade', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, 1);
    await flushGpuPromises();
    renderer.bindTopology(preparedScene(sampleTopology()));
    h.device.createRenderPipelineAsync.mockRejectedValueOnce(new Error('bad wgsl'));

    await expect(
      renderer.setShade('fn shade(f: Fragment) -> vec4f { return nope; }'),
    ).rejects.toThrow('network shader build failed:\nbad wgsl');
    expect(renderer.render(createUniforms())).toBe(true);

    await renderer.warmProjection('globe');
    const latest = h.device.shaderModules.filter((module) => module.label === 'vert').at(-1)!;
    expect(latest.code).toContain('return f.color;');
    renderer.destroy();
  });

  it('lets the latest shade win and discards builds that started under an older one', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, 1);
    const ready = vi.fn();
    renderer.onPipelinesReady = ready;
    await flushGpuPromises();
    ready.mockClear();
    const before = h.device.renderPipelines.length;

    const stale = renderer.warmProjection('globe');
    const first = renderer.setShade('fn shade(f: Fragment) -> vec4f { return vec4f(0.0); }');
    const second = renderer.setShade(custom);
    await Promise.all([stale, first, second]);

    expect(ready).toHaveBeenCalledOnce();
    const latest = h.device.shaderModules.filter((module) => module.label === 'vert').at(-1)!;
    expect(latest.code).toContain('return f.color * 2.0;');
    // The stale globe build never landed: warming builds it again under the new shade.
    const built = h.device.renderPipelines.length - before;
    await renderer.warmProjection('globe');
    expect(h.device.renderPipelines.length - before).toBe(built + 10);
    renderer.destroy();
  });
});
