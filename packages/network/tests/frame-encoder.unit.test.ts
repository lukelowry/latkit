/// <reference types="@webgpu/types" />

import { describe, expect, it, vi } from 'vitest';
import { encodeNetworkFrame, type EncodeNetworkFrameInputs } from '../src/webgpu/frame-encoder.js';

function makeInputs(overrides: Partial<EncodeNetworkFrameInputs> = {}) {
  const draw = vi.fn();
  const drawIndexed = vi.fn();
  const drawIndirect = vi.fn();
  const rp = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    draw,
    drawIndexed,
    drawIndirect,
    end: vi.fn(),
  };
  const encoder = {
    beginRenderPass: vi.fn(() => rp),
  } as unknown as GPUCommandEncoder;

  const inputs: EncodeNetworkFrameInputs = {
    encoder,
    colorAttachment: {} as GPURenderPassColorAttachment,
    depthView: {} as GPUTextureView,
    drawBackground: false,
    visual: {
      vertex: {} as GPURenderPipeline,
      vertexHalo: {} as GPURenderPipeline,
      vertexFocus: {} as GPURenderPipeline,
      edge: {} as GPURenderPipeline,
      edgeHalo: {} as GPURenderPipeline,
      edgeFocus: {} as GPURenderPipeline,
      pole: {} as GPURenderPipeline,
      borders: {} as GPURenderPipeline,
      bg: {} as GPURenderPipeline,
      earthAxis: {} as GPURenderPipeline,
    },
    channelsBindGroup: {} as GPUBindGroup,
    topologyBindGroup: {} as GPUBindGroup,
    segmentsBindGroup: {} as GPUBindGroup,
    topology: { vertexCount: 0, segmentCount: 7 },
    borders: null,
    visibility: { vertices: false, edges: true, poles: false, borders: false, earthAxis: false },
    unitQuad: {} as GPUBuffer,
    edgeStrip: {} as GPUBuffer,
    focusedVertices: [],
    edgeFocusRanges: [],
    polesRendered: false,
    ...overrides,
  };
  return { inputs, rp, draw, drawIndexed, drawIndirect };
}

describe('encodeNetworkFrame edge draws', () => {
  it('draws all edges directly from topology segments', () => {
    const { inputs, draw, drawIndirect } = makeInputs();

    encodeNetworkFrame(inputs);

    expect(draw).toHaveBeenCalledWith(4, 7);
    expect(drawIndirect).not.toHaveBeenCalled();
  });

  it('draws focused edge ranges with firstInstance offsets', () => {
    const { inputs, draw, drawIndirect } = makeInputs({
      edgeFocusRanges: [{ start: 2, end: 5 }],
    });

    encodeNetworkFrame(inputs);

    expect(draw).toHaveBeenCalledWith(4, 7);
    expect(draw).toHaveBeenCalledWith(4, 3, 0, 2);
    expect(drawIndirect).not.toHaveBeenCalled();
  });

  it('does not bind the edge segment group for vertex-only frames', () => {
    const { inputs, rp, draw } = makeInputs({
      topology: { vertexCount: 3, segmentCount: 7 },
      visibility: { vertices: true, edges: false, poles: false, borders: false, earthAxis: false },
    });

    encodeNetworkFrame(inputs);

    expect(draw).toHaveBeenCalledWith(4, 3);
    expect(rp.setBindGroup).not.toHaveBeenCalledWith(2, inputs.segmentsBindGroup);
  });

  it('draws the earth axis after the background and before borders', () => {
    const bg = { label: 'bg' } as unknown as GPURenderPipeline;
    const earthAxis = { label: 'earthAxis' } as unknown as GPURenderPipeline;
    const borders = { label: 'borders' } as unknown as GPURenderPipeline;
    const borderBuffers = {
      bind: vi.fn(),
      indexCount: 8,
    };
    const { inputs, rp, draw, drawIndexed } = makeInputs({
      drawBackground: true,
      visual: {
        vertex: {} as GPURenderPipeline,
        vertexHalo: {} as GPURenderPipeline,
        vertexFocus: {} as GPURenderPipeline,
        edge: {} as GPURenderPipeline,
        edgeHalo: {} as GPURenderPipeline,
        edgeFocus: {} as GPURenderPipeline,
        pole: {} as GPURenderPipeline,
        borders,
        bg,
        earthAxis,
      },
      borders: borderBuffers as never,
      visibility: { vertices: false, edges: false, poles: false, borders: true, earthAxis: true },
    });

    encodeNetworkFrame(inputs);

    expect(rp.setPipeline).toHaveBeenNthCalledWith(1, bg);
    expect(rp.setPipeline).toHaveBeenNthCalledWith(2, earthAxis);
    expect(rp.setPipeline).toHaveBeenNthCalledWith(3, borders);
    expect(draw).toHaveBeenCalledWith(3);
    expect(draw).toHaveBeenCalledWith(4, 2);
    expect(drawIndexed).toHaveBeenCalledWith(8);
  });
});
