/// <reference types="@webgpu/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Renderer } from '../src/webgpu/renderer.js';
import { encodeTopology, type Topology } from '../src/topology/index.js';
import { encodeSegments } from '../src/segments/index.js';
import { prepareScene, type PreparedScene } from '../src/scene.js';
import {
  createUniforms,
  FLAG_FOCUS_ENABLED,
  FLAG_FOCUS_HOVER_ENDPOINTS,
  FLAG_FOCUS_SELECTED_ENDPOINTS,
  FLAG_GRATICULE,
} from '../src/webgpu/uniforms.js';
import { BORDER_VERTEX_STRIDE_BYTES } from '../src/borders.js';
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
      'unitQuad',
      'edgeQuad',
      'uniforms',
    ]);
    expect(h.device.textures.map((texture) => texture.descriptor.label)).toEqual(['colormap-lut']);
    expect(h.device.queue.writeTexture).toHaveBeenCalledOnce();
    expect(h.device.renderPipelines.map((pipeline) => pipeline.label)).toContain('plane-bg');

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
      h.device.renderPipelines.filter((pipeline) => pipeline.label === 'globe-bg'),
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
    expect(reported).toHaveBeenCalledWith('plane', failure);
    expect(h.device.createRenderPipelineAsync).toHaveBeenCalledTimes(calls);
    renderer.destroy();
  });

  it('binds topology transactionally and replaces channel storage on relayout', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const topology = sampleTopology();

    renderer.bindTopology(preparedScene(topology));
    const initialChannelBuffer = h.device.buffers.find(
      (buffer) => buffer.descriptor.label === 'channels',
    );

    const slots = renderer.relayout(new Set(['vertexColor', 'edgeDash']), 3, 2);

    expect(slots.get('vertexColor')).toEqual({ offset: 0, count: 3 });
    expect(slots.get('edgeDash')).toEqual({ offset: 3, count: 2 });
    expect(initialChannelBuffer?.destroyed).toBe(true);

    const values = new Float32Array([1, 0]);
    renderer.writeChannel('edgeDash', values);
    expect(h.device.queue.writeBuffer).toHaveBeenLastCalledWith(
      expect.anything(),
      12,
      values.buffer,
      values.byteOffset,
      values.byteLength,
    );

    renderer.destroy();
  });

  it('keeps previous channel storage when a transactional relayout upload fails', () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const topology = sampleTopology();
    renderer.bindTopology(preparedScene(topology));
    const previous = h.device.buffers.find((buffer) => buffer.descriptor.label === 'channels')!;
    const failure = new Error('queue rejected channel upload');
    h.device.queue.writeBuffer.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() =>
      renderer.relayout(
        new Set(['vertexColor']),
        3,
        2,
        new Map([['vertexColor', new Float32Array([0, 0.5, 1])]]),
      ),
    ).toThrow(failure);

    const attempted = h.device.buffers.at(-1)!;
    expect(attempted).not.toBe(previous);
    expect(attempted.destroyed).toBe(true);
    expect(previous.destroyed).toBe(false);
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
    uniforms.light.flags = FLAG_GRATICULE;
    uniforms.focus.flags =
      FLAG_FOCUS_ENABLED | FLAG_FOCUS_HOVER_ENDPOINTS | FLAG_FOCUS_SELECTED_ENDPOINTS;
    uniforms.focus.hoverVertex = 2;
    uniforms.focus.selectedVertex = 2;
    uniforms.focus.hoverEdge = 1;
    uniforms.focus.selectedEdge = 1;
    uniforms.focus.setEndpointIds(0, 2, 1, 2);

    expect(renderer.render(uniforms)).toBe(true);

    const pass = h.device.encoders[0]!.passes[0]!;
    expect(pass.setPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'plane-bg' }) as GPURenderPipeline,
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
    uniforms.focus.flags = FLAG_FOCUS_ENABLED;
    uniforms.focus.hoverEdge = 0;

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
    renderer.setVisible({ poles: true });

    expect(renderer.render(uniforms)).toBe(true);

    const labels = h.device.encoders[0]!.passes[0]!.calls.filter(
      (call) => call.method === 'setPipeline',
    ).map((call) => (call.args[0] as { label?: string }).label);
    expect(labels).toContain('plane-pole');
    renderer.destroy();
  });
});
