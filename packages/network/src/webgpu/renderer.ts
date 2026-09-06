/// <reference types="@webgpu/types" />

import type { Presentation } from '@latkit/gpu';
import { bakeColormap, COLORMAP_LUT_SIZE } from '@latkit/model';
import {
  UNIFORM_BUFFER_BYTES,
  hasSceneDepth,
  hasVertexHeightChannel,
  FOCUS_ENABLED,
  FOCUS_HOVER_ENDPOINTS,
  FOCUS_SELECTED_ENDPOINTS,
  W_FOCUS_FLAGS,
  W_E_HOVER_ID,
  W_HOVER_ENDPOINT_A,
  W_HOVER_ENDPOINT_B,
  W_V_HOVER_ID,
  W_E_SELECTED_ID,
  W_SELECTED_ENDPOINT_A,
  W_SELECTED_ENDPOINT_B,
  W_V_SELECTED_ID,
  type Uniforms,
} from './uniforms.js';
import type { PreparedScene } from '../scene.js';
import type { Borders } from '../borders/index.js';
import { BorderBuffers } from './border-buffers.js';
import { channelLayout, type Channel } from '../channels.js';
import { DEFAULT_OPTIONS } from '../options.js';

import {
  PIPELINES,
  PROJECTION_DEFS,
  type PipelineDef,
  type ProjectionFamily,
  type Projection,
} from '../projections.js';

import { FrameResources } from './frame-resources.js';
import { encodeNetworkFrame, type FramePasses } from './frame-encoder.js';
import {
  buildProjectionPipelines as buildProjectionPipelineSet,
  type ProjectionPipelineSet,
} from './pipelines.js';

/** Uniform views the renderer uploads or inspects during a frame. */
type FrameUniforms = Pick<Uniforms, 'raw' | 'rawF32' | 'rawI32' | 'rawU32'>;

/**
 * Transparent clear color that lets the themed DOM behind the premultiplied
 * canvas provide the projection backdrop.
 */
const TRANSPARENT_CLEAR: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

/** Counts needed to issue draw calls for a bound topology. */
interface BoundTopology {
  /** Number of topology vertices. */
  readonly vertexCount: number;
  /** Number of topology edges. */
  readonly edgeCount: number;
  /** Number of encoded edge segments. */
  readonly segmentCount: number;
}

/** Half-open segment range belonging to one focused edge; reused frame to frame. */
interface EdgeFocusRange {
  /** First segment index to draw. */
  start: number;
  /** Segment index immediately after the focused range. */
  end: number;
}

/** The most ids a frame's focus can name: hover, selection, and two endpoints each. */
const MAX_FOCUSED_VERTICES = 6;

/**
 * Owns all GPU resources required to render a network scene.
 *
 * Topology uploads are transactional: new resources are allocated and bound
 * before replacing the current scene.
 */
export class Renderer {
  private readonly presentation: Presentation;

  private readonly topologyBindGroupLayout: GPUBindGroupLayout;
  private readonly segmentsBindGroupLayout: GPUBindGroupLayout;
  private readonly channelsBindGroupLayout: GPUBindGroupLayout;
  private readonly overlayPipelineLayout: GPUPipelineLayout;
  private readonly edgePipelineLayout: GPUPipelineLayout;
  private readonly backgroundPipelineLayout: GPUPipelineLayout;
  private readonly warnedEmptyEdgeFocusRanges = new Set<number>();

  private readonly frameResources = new FrameResources();
  private readonly pipelines = new Map<ProjectionFamily, ProjectionPipelineSet>();
  private readonly buildingPipelines = new Map<ProjectionFamily, Promise<void>>();
  private readonly failedPipelines = new Set<ProjectionFamily>();
  private activeFamily: ProjectionFamily = 'plane';
  /**
   * MSAA is 4x or off because WebGPU permits only 1 and 4, and the sample
   * count is baked into every pipeline.
   */
  private readonly sampleCount: 1 | 4;
  /** Fires when an async pipeline-family build lands. */
  onPipelinesReady?: () => void;
  /** Reports a failed async pipeline-family build. */
  onPipelineError?: (family: ProjectionFamily, cause: unknown) => void;

  private readonly unitQuad: GPUBuffer;
  private readonly edgeStrip: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  /** Transfer-function texture sampled by color channels. */
  private readonly cmLut: GPUTexture;
  private readonly cmSampler: GPUSampler;

  private topology: BoundTopology | null = null;
  private edgeSegStart: Uint32Array = new Uint32Array(0);
  private topologyBuffer: GPUBuffer | null = null;
  private topologyBindGroup: GPUBindGroup | null = null;
  private segmentBuffer: GPUBuffer | null = null;
  private segmentsBindGroup: GPUBindGroup | null = null;
  private channelBuf: GPUBuffer | null = null;
  private channelsBindGroup: GPUBindGroup | null = null;
  /** Float-word offset of every channel's slot in the bound topology's storage. */
  private channelOffsets: Readonly<Record<Channel, number>> | null = null;
  private borders: BorderBuffers | null = null;

  // Per-frame focus scratch; a frame allocates nothing for its overlays.
  private readonly focusedVertices: number[] = [];
  private readonly focusedEdges: number[] = [];
  private readonly edgeFocusRanges: EdgeFocusRange[] = [];
  private edgeFocusRangeCount = 0;

  private bound = false;
  private destroyed = false;
  private passes: FramePasses = {
    vertices: DEFAULT_OPTIONS.vertices,
    edges: DEFAULT_OPTIONS.edges,
    poles: DEFAULT_OPTIONS.poles,
    borders: DEFAULT_OPTIONS.borders,
    earthAxis: DEFAULT_OPTIONS.earthAxis,
  };

  /** Allocates shared layouts, static geometry, uniforms, and the initial projection pipeline build. */
  constructor(presentation: Presentation, msaaSampleCount?: 1 | 4) {
    this.presentation = presentation;
    const { device } = presentation;
    // 4x attachments at 4K-class resolutions cost ~265MB; above ~7M device
    // pixels (native 4K, or DPR-2 4K) the analytic shader AA carries 1x.
    const { canvas } = presentation;
    const view = 'ownerDocument' in canvas ? canvas.ownerDocument?.defaultView : null;
    const display = view?.screen ?? (typeof screen === 'undefined' ? undefined : screen);
    const pixelRatio =
      view?.devicePixelRatio ?? (typeof devicePixelRatio === 'undefined' ? 1 : devicePixelRatio);
    const devicePx = display ? display.width * display.height * pixelRatio ** 2 : 0;
    this.sampleCount = msaaSampleCount ?? (devicePx > 7_000_000 ? 1 : 4);

    this.unitQuad = device.createBuffer({
      label: 'unit-quad',
      size: 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.unitQuad, 0, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));

    this.edgeStrip = device.createBuffer({
      label: 'edge-strip',
      size: 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.edgeStrip, 0, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]));

    this.uniforms = device.createBuffer({
      label: 'uniforms',
      size: UNIFORM_BUFFER_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.cmLut = device.createTexture({
      label: 'colormap-lut',
      size: [COLORMAP_LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.cmSampler = device.createSampler({
      label: 'colormap-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.writeColormap(bakeColormap(DEFAULT_OPTIONS.colormap));

    this.channelsBindGroupLayout = device.createBindGroupLayout({
      label: 'channels-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });
    this.topologyBindGroupLayout = device.createBindGroupLayout({
      label: 'topology-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });
    this.segmentsBindGroupLayout = device.createBindGroupLayout({
      label: 'segments-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });
    this.overlayPipelineLayout = device.createPipelineLayout({
      label: 'network-overlay-pipeline-layout',
      bindGroupLayouts: [this.channelsBindGroupLayout, this.topologyBindGroupLayout],
    });
    this.edgePipelineLayout = device.createPipelineLayout({
      label: 'network-edge-pipeline-layout',
      bindGroupLayouts: [
        this.channelsBindGroupLayout,
        this.topologyBindGroupLayout,
        this.segmentsBindGroupLayout,
      ],
    });
    this.backgroundPipelineLayout = device.createPipelineLayout({
      label: 'network-background-pipeline-layout',
      bindGroupLayouts: [this.channelsBindGroupLayout],
    });

    // Pipeline sets come from the family registry: one bundle per family
    // carries the overlay prelude, the background shader (which writes the
    // depth all overlays occlusion-test against), and the border_world
    // snippet (final lifted position included). Builds are async and lazy: the
    // active family compiles off-thread while the topology loads, and
    // render() simply skips frames until it lands (the loop treats a null
    // render as "no frame"). The controller warms supported alternatives after first paint.
    void this.ensurePipelines(this.activeFamily);
  }

  /** Selects the active pipeline family for a mode, building it lazily if needed. */
  useProjection(mode: Projection): void {
    this.activeFamily = PROJECTION_DEFS[mode].family;
    void this.ensurePipelines(this.activeFamily);
  }

  /** Compiles a mode's pipeline family without changing the active one. */
  warmProjection(mode: Projection): Promise<void> {
    return this.ensurePipelines(PROJECTION_DEFS[mode].family);
  }

  /** Returns the cached or in-flight build for one pipeline family. */
  private ensurePipelines(family: ProjectionFamily): Promise<void> {
    if (this.pipelines.has(family) || this.failedPipelines.has(family)) {
      return Promise.resolve();
    }
    const pending = this.buildingPipelines.get(family);
    if (pending) return pending;

    const build = this.buildPipelines(PIPELINES[family]).then(
      (pipelines) => {
        this.buildingPipelines.delete(family);
        if (this.destroyed) return;
        this.pipelines.set(family, pipelines);
        this.onPipelinesReady?.();
      },
      (error: unknown) => {
        this.buildingPipelines.delete(family);
        if (this.destroyed) return;
        this.failedPipelines.add(family);
        this.onPipelineError?.(family, error);
        // Pipeline validation failing is a build-time shader bug; keep the
        // session alive (render() keeps skipping) and surface the cause.
        console.error(`network: failed to build the ${family} projection pipelines`, error);
      },
    );
    this.buildingPipelines.set(family, build);
    return build;
  }

  /** Builds all GPU pipelines required by a pipeline definition. */
  private async buildPipelines(def: PipelineDef): Promise<ProjectionPipelineSet> {
    return buildProjectionPipelineSet(def, {
      device: this.presentation.device,
      format: this.presentation.format,
      sampleCount: this.sampleCount,
      overlayPipelineLayout: this.overlayPipelineLayout,
      edgePipelineLayout: this.edgePipelineLayout,
      backgroundPipelineLayout: this.backgroundPipelineLayout,
    });
  }

  /** Updates the passes drawn when encoding future frames. */
  setPasses(passes: Partial<FramePasses>): void {
    Object.assign(this.passes, passes);
  }

  /** Replaces the optional geographic border buffers. */
  setBorders(borders: Borders | null): void {
    const next = borders ? BorderBuffers.create(this.presentation.device, borders) : null;
    const previous = this.borders;
    this.borders = next;
    previous?.destroy();
  }

  /** Uploads and binds an already validated prepared scene. */
  bindTopology(scene: PreparedScene): void {
    const encoded = scene.topology;
    const encodedSegments = scene.segments.encoded;
    const info = scene.info;
    const segmentInfo = scene.segments.info;
    const edgeSegStart = scene.segments.edgeStarts;

    const topologyBytes = encoded.byteLength;
    const segmentBytes = encodedSegments.byteLength;
    // Every channel owns a slot for the topology's lifetime, so a bind is one upload and the
    // limits are checked once, here, rather than on every first binding.
    const layout = channelLayout(info.vertexCount, info.edgeCount);
    const channelBytes = Math.max(4, layout.words * Float32Array.BYTES_PER_ELEMENT);
    this.assertStorageBufferFits('topology', topologyBytes);
    this.assertStorageBufferFits('segment', segmentBytes);
    this.assertStorageBufferFits('channel', channelBytes);

    let topologyBuffer: GPUBuffer | null = null;
    let segmentBuffer: GPUBuffer | null = null;
    let channelBuf: GPUBuffer | null = null;
    let next: {
      readonly topologyBuffer: GPUBuffer;
      readonly topologyBindGroup: GPUBindGroup;
      readonly segmentBuffer: GPUBuffer;
      readonly segmentsBindGroup: GPUBindGroup;
      readonly channelBuf: GPUBuffer;
      readonly channelsBindGroup: GPUBindGroup;
    };
    try {
      topologyBuffer = this.presentation.device.createBuffer({
        label: 'network-topology',
        size: topologyBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.presentation.device.queue.writeBuffer(topologyBuffer, 0, encoded);
      const topologyBindGroup = this.presentation.device.createBindGroup({
        label: 'network-topology-bind-group',
        layout: this.topologyBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: topologyBuffer } }],
      });
      segmentBuffer = this.presentation.device.createBuffer({
        label: 'network-segments',
        size: segmentBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      // Bind the encoded segment blob directly, mirroring topology. The shader
      // uses the record offset in the header; the prepared edgeStarts copy
      // also stays available to CPU focus range code.
      this.presentation.device.queue.writeBuffer(segmentBuffer, 0, encodedSegments);
      const segmentsBindGroup = this.presentation.device.createBindGroup({
        label: 'network-segments-bind-group',
        layout: this.segmentsBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: segmentBuffer } }],
      });
      channelBuf = this.presentation.device.createBuffer({
        label: 'channels',
        size: channelBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const channelsBindGroup = this.createChannelsBindGroup(channelBuf);
      next = {
        topologyBuffer,
        topologyBindGroup,
        segmentBuffer,
        segmentsBindGroup,
        channelBuf,
        channelsBindGroup,
      };
      topologyBuffer = null;
      segmentBuffer = null;
      channelBuf = null;
    } catch (error) {
      topologyBuffer?.destroy();
      segmentBuffer?.destroy();
      channelBuf?.destroy();
      throw error;
    }
    this.destroyTopology();
    this.topologyBuffer = next.topologyBuffer;
    this.topologyBindGroup = next.topologyBindGroup;
    this.segmentBuffer = next.segmentBuffer;
    this.segmentsBindGroup = next.segmentsBindGroup;
    this.channelBuf = next.channelBuf;
    this.channelsBindGroup = next.channelsBindGroup;
    this.topology = {
      vertexCount: info.vertexCount,
      edgeCount: info.edgeCount,
      segmentCount: segmentInfo.segmentCount,
    };
    this.edgeSegStart = edgeSegStart;
    this.channelOffsets = layout.offsets;
    this.bound = true;
  }

  /** Throws when a storage allocation would exceed the current device limits. */
  private assertStorageBufferFits(label: string, bytes: number): void {
    const limits = this.presentation.device.limits;
    const maxStorageBytes = limits?.maxStorageBufferBindingSize ?? Number.POSITIVE_INFINITY;
    if (bytes > maxStorageBytes) {
      throw new Error(
        `network ${label} storage ${bytes} exceeds WebGPU storage buffer binding limit ${maxStorageBytes}`,
      );
    }
    const maxBufferBytes = limits?.maxBufferSize ?? Number.POSITIVE_INFINITY;
    if (bytes > maxBufferBytes) {
      throw new Error(
        `network ${label} storage ${bytes} exceeds WebGPU buffer size limit ${maxBufferBytes}`,
      );
    }
  }

  /** Writes one channel's values into its slot of the bound topology's storage. */
  writeChannel(channel: Channel, values: Float32Array): void {
    const offset = this.channelOffsets?.[channel];
    if (offset === undefined || !this.channelBuf) {
      throw new Error(`network channel ${channel} has no storage slot`);
    }
    this.presentation.device.queue.writeBuffer(
      this.channelBuf,
      offset * Float32Array.BYTES_PER_ELEMENT,
      values.buffer,
      values.byteOffset,
      values.byteLength,
    );
  }

  /** Uploads a baked colormap with `COLORMAP_LUT_SIZE * 4` RGBA bytes. */
  writeColormap(lut: Uint8Array): void {
    this.presentation.device.queue.writeTexture(
      { texture: this.cmLut },
      lut as Uint8Array<ArrayBuffer>,
      { bytesPerRow: COLORMAP_LUT_SIZE * 4 },
      [COLORMAP_LUT_SIZE, 1],
    );
  }

  /**
   * Encodes and submits one frame.
   *
   * @returns Whether a frame was actually submitted.
   */
  render(uniforms: FrameUniforms): boolean {
    // No frame until the active pipeline-family build lands; the loop
    // treats a null render as "skip", and onPipelinesReady wakes it.
    const pipelines = this.pipelines.get(this.activeFamily);
    if (
      !pipelines ||
      !this.bound ||
      !this.topology ||
      !this.topologyBindGroup ||
      !this.segmentsBindGroup ||
      !this.channelsBindGroup
    )
      return false;
    const { device, context, canvas } = this.presentation;
    const polesRendered = this.computePolesRendered(uniforms);

    device.queue.writeBuffer(this.uniforms, 0, uniforms.raw);

    const pw = canvas.width,
      ph = canvas.height;
    this.frameResources.ensureSize(device, this.presentation.format, this.sampleCount, pw, ph);
    const visual = pipelines.visual;

    const swapView = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();

    this.collectFocusedEdges(uniforms);
    this.collectFocusedVertices(uniforms);
    this.edgeFocusRangeCount = 0;
    for (const edge of this.focusedEdges) {
      const start = this.edgeSegStart[edge] ?? 0;
      const end = this.edgeSegStart[edge + 1] ?? start;
      if (end > start) {
        const range = (this.edgeFocusRanges[this.edgeFocusRangeCount] ??= { start: 0, end: 0 });
        range.start = start;
        range.end = end;
        this.edgeFocusRangeCount++;
      } else if (!this.warnedEmptyEdgeFocusRanges.has(edge)) {
        this.warnedEmptyEdgeFocusRanges.add(edge);
        console.warn(
          `network: focused edge ${edge} has an empty segment range; base rendering remains active`,
        );
      }
    }
    this.edgeFocusRanges.length = this.edgeFocusRangeCount;

    encodeNetworkFrame({
      encoder,
      colorAttachment: this.frameResources.colorAttachment(
        this.sampleCount,
        swapView,
        TRANSPARENT_CLEAR,
      ),
      depthView: this.frameResources.depthView,
      visual,
      channelsBindGroup: this.channelsBindGroup,
      topologyBindGroup: this.topologyBindGroup,
      segmentsBindGroup: this.segmentsBindGroup,
      topology: this.topology,
      borders: this.borders,
      passes: this.passes,
      unitQuad: this.unitQuad,
      edgeStrip: this.edgeStrip,
      focusedVertices: this.focusedVertices,
      edgeFocusRanges: this.edgeFocusRanges,
      polesRendered,
    });

    device.queue.submit([encoder.finish()]);
    return true;
  }

  /** Returns whether the height-pole pass has visible output for this frame. */
  private computePolesRendered(uniforms: FrameUniforms): boolean {
    return (
      this.passes.poles && hasSceneDepth(uniforms.rawF32) && hasVertexHeightChannel(uniforms.rawU32)
    );
  }

  /** Collects the selected and hovered edge ids from focus uniforms into the frame scratch. */
  private collectFocusedEdges(uniforms: FrameUniforms): void {
    const out = this.focusedEdges;
    out.length = 0;
    if (
      !this.topology ||
      !this.passes.edges ||
      (uniforms.rawU32[W_FOCUS_FLAGS]! & FOCUS_ENABLED) === 0
    ) {
      return;
    }
    const limit = this.topology.edgeCount;
    pushUnique(out, uniforms.rawI32[W_E_SELECTED_ID]!, limit);
    pushUnique(out, uniforms.rawI32[W_E_HOVER_ID]!, limit);
  }

  /** Collects selected, hovered, and endpoint vertex ids from focus uniforms into the frame scratch. */
  private collectFocusedVertices(uniforms: FrameUniforms): void {
    const out = this.focusedVertices;
    out.length = 0;
    if (!this.topology || !this.passes.vertices) return;
    const flags = uniforms.rawU32[W_FOCUS_FLAGS]!;
    if ((flags & FOCUS_ENABLED) === 0) return;

    const limit = this.topology.vertexCount;
    const ids = uniforms.rawI32;
    pushUnique(out, ids[W_V_HOVER_ID]!, limit);
    pushUnique(out, ids[W_V_SELECTED_ID]!, limit);
    if ((flags & FOCUS_HOVER_ENDPOINTS) !== 0) {
      pushUnique(out, ids[W_HOVER_ENDPOINT_A]!, limit);
      pushUnique(out, ids[W_HOVER_ENDPOINT_B]!, limit);
    }
    if ((flags & FOCUS_SELECTED_ENDPOINTS) !== 0) {
      pushUnique(out, ids[W_SELECTED_ENDPOINT_A]!, limit);
      pushUnique(out, ids[W_SELECTED_ENDPOINT_B]!, limit);
    }
  }

  /** Releases all GPU resources owned by the renderer. */
  destroy(): void {
    this.destroyed = true;
    this.destroyTopology();
    this.frameResources.destroy();
    this.borders?.destroy();
    this.borders = null;
    this.unitQuad.destroy();
    this.uniforms.destroy();
    this.edgeStrip.destroy();
    this.cmLut.destroy();
  }

  /** Creates the bind group containing uniforms, channel storage, and colormap resources. */
  private createChannelsBindGroup(channelBuf: GPUBuffer): GPUBindGroup {
    return this.presentation.device.createBindGroup({
      label: 'channels-bind-group',
      layout: this.channelsBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: { buffer: channelBuf } },
        { binding: 2, resource: this.cmLut.createView() },
        { binding: 3, resource: this.cmSampler },
      ],
    });
  }

  /** Releases scene-specific topology, segment, and channel resources. */
  private destroyTopology(): void {
    this.topologyBuffer?.destroy();
    this.topologyBuffer = null;
    this.segmentBuffer?.destroy();
    this.segmentBuffer = null;
    this.channelBuf?.destroy();
    this.channelBuf = null;
    this.channelsBindGroup = null;
    this.channelOffsets = null;
    this.topology = null;
    this.edgeSegStart = new Uint32Array(0);
    this.topologyBindGroup = null;
    this.segmentsBindGroup = null;
    this.warnedEmptyEdgeFocusRanges.clear();
    this.bound = false;
  }
}

/** Append a valid, unseen id below `limit`; the focus lists are at most six long. */
function pushUnique(out: number[], id: number, limit: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= limit || out.length >= MAX_FOCUSED_VERTICES) return;
  for (const seen of out) if (seen === id) return;
  out.push(id);
}
