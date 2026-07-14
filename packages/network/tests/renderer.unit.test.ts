/// <reference types="@webgpu/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Renderer } from '../src/webgpu/renderer.js';
import { encodeTopology } from '../src/topology/index.js';
import { encodeSegments, type EncodedSegments } from '../src/segments/index.js';
import { W as SEG_W } from '../src/segments/wire.js';
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
    expect(h.device.renderPipelines.map((pipeline) => pipeline.label)).toContain('flat-bg');

    renderer.destroy();
    expect(h.device.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(h.device.textures.every((texture) => texture.destroyed)).toBe(true);
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

  it('dedupes lazy projection builds and wakes when they are ready', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const ready = vi.fn();
    renderer.onProjectionPipelinesReady = ready;

    await flushGpuPromises();
    ready.mockClear();

    renderer.useProjectionPipelines('globe');
    renderer.useProjectionPipelines('globe');
    await flushGpuPromises();

    expect(ready).toHaveBeenCalledOnce();
    expect(
      h.device.renderPipelines.filter((pipeline) => pipeline.label === 'globe-bg'),
    ).toHaveLength(1);
    renderer.destroy();
  });

  it('logs projection build failures without throwing out of construction', async () => {
    const h = makeFakeGpu();
    h.device.createRenderPipelineAsync.mockRejectedValueOnce(new Error('shader no good'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const renderer = new Renderer(h.presentation);
    await flushGpuPromises();

    expect(error).toHaveBeenCalledWith(
      'network: failed to build the flat projection pipelines',
      expect.any(Error),
    );
    renderer.destroy();
  });

  it('binds topology transactionally and replaces channel storage on relayout', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const topology = sampleTopology();

    renderer.bindTopology(encodeTopology(topology), encodeSegments(topology));
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

  it('rejects mismatched segment metadata before replacing the current scene', () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation);
    const topology = sampleTopology();
    const encodedTopology = encodeTopology(topology);

    const corrupt = (mutate: (words: Uint32Array) => void): EncodedSegments => {
      const encoded = encodeSegments(topology);
      const copy = new Uint8Array(encoded) as EncodedSegments;
      mutate(new Uint32Array(copy.buffer));
      return copy;
    };

    expect(() =>
      renderer.bindTopology(
        encodedTopology,
        corrupt((words) => {
          words[SEG_W.vertexCount] = 99;
        }),
      ),
    ).toThrow('network segment vertex count does not match topology');
    expect(() =>
      renderer.bindTopology(
        encodedTopology,
        encodeSegments(
          sampleTopology({
            edges: new Uint32Array([0, 1]),
            polylineStart: new Uint32Array([0, 0]),
            polylinePoints: new Float32Array(0),
          }),
        ),
      ),
    ).toThrow('network segment edge count does not match topology');
    expect(() =>
      renderer.bindTopology(
        encodedTopology,
        corrupt((words) => {
          words[SEG_W.fingerprint] = 99;
        }),
      ),
    ).toThrow('network segment fingerprint does not match topology');

    renderer.destroy();
  });

  it('cleans partially allocated topology resources when a later allocation fails', () => {
    const h = makeFakeGpu();
    h.device.failBufferLabels.add('network-segments');
    const renderer = new Renderer(h.presentation);
    const topology = singleEdgeTopology();

    expect(() => renderer.bindTopology(encodeTopology(topology), encodeSegments(topology))).toThrow(
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

    expect(() => renderer.bindTopology(encodeTopology(topology), encodeSegments(topology))).toThrow(
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
    renderer.bindTopology(encodeTopology(topology), encodeSegments(topology));

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
    renderer.bindTopology(encodeTopology(topology), encodeSegments(topology));
    await flushGpuPromises();

    const uniforms = createUniforms();
    uniforms.projection.flags = FLAG_GRATICULE;
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
      expect.objectContaining({ label: 'flat-bg' }) as GPURenderPipeline,
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
    renderer.bindTopology(encodeTopology(topology), encodeSegments(topology));
    await flushGpuPromises();
    (renderer as unknown as { edgeSegStart: Uint32Array }).edgeSegStart = new Uint32Array([
      0, 0, 4,
    ]);

    const uniforms = createUniforms();
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
    renderer.bindTopology(encodeTopology(topology), encodeSegments(topology));
    renderer.useProjectionPipelines('tilt');
    await flushGpuPromises();

    const uniforms = createUniforms();
    uniforms.channel.vHeightMode = 1;
    renderer.setVisible({ poles: true });

    expect(renderer.render(uniforms)).toBe(true);

    const labels = h.device.encoders[0]!.passes[0]!.calls.filter(
      (call) => call.method === 'setPipeline',
    ).map((call) => (call.args[0] as { label?: string }).label);
    expect(labels).toContain('tilt-pole');
    renderer.destroy();
  });
});
