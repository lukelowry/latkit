/// <reference types="@webgpu/types" />

import type { BorderBuffers } from './border-buffers.js';
import type { VisualPipelines } from './pipelines.js';

/** Layer flags resolved for a single encoded frame. */
interface FrameVisibility {
  /** Draw vertex billboards. */
  vertices: boolean;
  /** Draw edge segments. */
  edges: boolean;
  /** Draw height poles. */
  poles: boolean;
  /** Draw geographic borders. */
  borders: boolean;
  /** Draw globe earth-axis indicator. */
  earthAxis: boolean;
}

/** Counts required by instanced draw calls. */
interface FrameTopology {
  /** Number of vertices in the bound topology. */
  vertexCount: number;
  /** Number of encoded edge segments in the bound topology. */
  segmentCount: number;
}

/** Inputs required to encode one render pass for the network scene. */
export interface EncodeNetworkFrameInputs {
  /** Command encoder receiving the render pass. */
  encoder: GPUCommandEncoder;
  /** Color attachment for the swapchain or MSAA target. */
  colorAttachment: GPURenderPassColorAttachment;
  /** Depth attachment view for this frame. */
  depthView: GPUTextureView;
  /** Active projection pipelines. */
  visual: VisualPipelines;
  /** Bind group containing uniforms, channel storage, and colormap texture. */
  channelsBindGroup: GPUBindGroup;
  /** Bind group for encoded topology storage. */
  topologyBindGroup: GPUBindGroup;
  /** Bind group for encoded segment storage. */
  segmentsBindGroup: GPUBindGroup;
  /** Draw counts for topology-dependent instancing. */
  topology: FrameTopology;
  /** Optional bound border buffers. */
  borders: BorderBuffers | null;
  /** Layer visibility resolved by the renderer. */
  visibility: FrameVisibility;
  /** Shared unit quad vertex buffer for billboard passes. */
  unitQuad: GPUBuffer;
  /** Shared edge strip vertex buffer for segment passes. */
  edgeStrip: GPUBuffer;
  /** Vertex ids that should receive focus rendering. */
  focusedVertices: readonly number[];
  /** Segment ranges for focused edges. */
  edgeFocusRanges: readonly { readonly start: number; readonly end: number }[];
  /** True when poles should be drawn for the current projection/channel state. */
  polesRendered: boolean;
}

/** Encodes all visible network draw calls into a single render pass. */
export function encodeNetworkFrame(inputs: EncodeNetworkFrameInputs): void {
  const rp = inputs.encoder.beginRenderPass({
    colorAttachments: [inputs.colorAttachment],
    depthStencilAttachment: {
      view: inputs.depthView,
      depthClearValue: 1.0,
      depthLoadOp: 'clear',
      depthStoreOp: 'discard',
    },
  });

  // The background is the scene's surface (ground plane or sphere) and its
  // depth reference; it draws every frame in every projection.
  rp.setPipeline(inputs.visual.bg);
  rp.setBindGroup(0, inputs.channelsBindGroup);
  rp.draw(3);

  if (inputs.visibility.earthAxis && inputs.visual.earthAxis) {
    rp.setPipeline(inputs.visual.earthAxis);
    rp.setBindGroup(0, inputs.channelsBindGroup);
    rp.draw(4, 2);
  }

  if (inputs.visibility.borders && inputs.borders) {
    rp.setPipeline(inputs.visual.borders);
    rp.setBindGroup(0, inputs.channelsBindGroup);
    inputs.borders.bind(rp);
    rp.drawIndexed(inputs.borders.indexCount);
  }

  if (inputs.visibility.edges) {
    rp.setVertexBuffer(0, inputs.edgeStrip);
    rp.setBindGroup(0, inputs.channelsBindGroup);
    rp.setBindGroup(1, inputs.topologyBindGroup);
    rp.setBindGroup(2, inputs.segmentsBindGroup);

    rp.setPipeline(inputs.visual.edge);
    rp.draw(4, inputs.topology.segmentCount);

    if (inputs.edgeFocusRanges.length > 0) {
      rp.setPipeline(inputs.visual.edgeHalo);
      drawFocusedEdges(rp, inputs);

      rp.setPipeline(inputs.visual.edgeFocus);
      drawFocusedEdges(rp, inputs);
    }
  }

  if (inputs.polesRendered) {
    rp.setPipeline(inputs.visual.pole);
    rp.setVertexBuffer(0, inputs.unitQuad);
    rp.setBindGroup(0, inputs.channelsBindGroup);
    rp.setBindGroup(1, inputs.topologyBindGroup);
    rp.draw(4, inputs.topology.vertexCount);
  }

  if (inputs.visibility.vertices) {
    rp.setPipeline(inputs.visual.vertex);
    rp.setVertexBuffer(0, inputs.unitQuad);
    rp.setBindGroup(0, inputs.channelsBindGroup);
    rp.setBindGroup(1, inputs.topologyBindGroup);
    rp.draw(4, inputs.topology.vertexCount);

    if (inputs.focusedVertices.length > 0) {
      rp.setPipeline(inputs.visual.vertexHalo);
      for (const vertex of inputs.focusedVertices) rp.draw(4, 1, 0, vertex);

      rp.setPipeline(inputs.visual.vertexFocus);
      for (const vertex of inputs.focusedVertices) rp.draw(4, 1, 0, vertex);
    }
  }

  rp.end();
}

/** Draws each focused edge as its contiguous encoded segment range. */
function drawFocusedEdges(rp: GPURenderPassEncoder, inputs: EncodeNetworkFrameInputs): void {
  for (const range of inputs.edgeFocusRanges) {
    const count = range.end - range.start;
    if (count > 0) rp.draw(4, count, 0, range.start);
  }
}
