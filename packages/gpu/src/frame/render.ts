import type { Colormap } from '../colors/colormap.js';
import type { ColormapName } from '../colors/catalog.js';
import type { EnvelopeBlock, FieldsBlock, ReadScope } from '@latkit/model';
import type { TextRequest, TextPage } from '../text/text.js';
import type { BufferResource } from '../memory/buffers.js';
import type { BufferData } from '../memory/buffer-data.js';
import type { GpuPage, UploadOptions } from '../fields/types.js';
import type { ShadeRequest } from '../style/shade.js';
import type { TextureData } from '../memory/texture-data.js';
import type { TextureResource } from '../memory/textures.js';

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

export interface FrameInfo {
  /** Actual target dimensions in physical pixels. */
  readonly width: number;
  readonly height: number;
  readonly at?: number;
  readonly timeMs: number;
  readonly viewport: Viewport;
  readonly format: GPUTextureFormat;
}

/** Methods and returned GPU descriptors are scoped to this frame. Reads must be consumed. */
export interface Preparation extends FrameInfo {
  readonly signal: AbortSignal;
  /** The GPU's reader, held for this frame: results stay cached until its work completes. */
  readonly reader: ReadScope;
  /** Shared effect uniforms consumed by shadeShader. */
  shade(request?: ShadeRequest): GPUBufferBinding;
  /** Frame-scoped shared binding; defaults to grayscale. Use Gpu.colormapLayout. */
  colormap(value?: Colormap | ColormapName): GPUBindGroup;
  text(request: TextRequest): Promise<readonly TextPage[]>;
  upload(block: FieldsBlock | EnvelopeBlock, options: UploadOptions): readonly GpuPage[];
  buffer(data: BufferData | BufferResource): GPUBufferBinding;
  /** Dedicated immutable uniform contents for this frame; safe across concurrent views. */
  uniforms(data: ArrayBufferView): GPUBufferBinding;
  /** Protect an owned texture until submitted work completes. */
  texture(resource: TextureResource | TextureData): GPUTexture;
}

export interface Encoding extends FrameInfo {
  readonly encoder: GPUCommandEncoder;
  readonly target: GPUTextureView;
}

/** Work captured synchronously before any renderer starts asynchronous preparation. */
export interface CapturedFrame {
  prepare(frame: Preparation): Promise<PreparedFrame>;
  /** Release the snapshot after preparation settles, whether submitted or cancelled. Idempotent. */
  release(): void;
}

/** A single candidate. Only submission may advance visible state or acknowledge work. */
export interface PreparedFrame {
  /** Synchronous: record commands, never submit the queue. */
  encode(frame: Encoding): void;
  /** Called after the whole frame is submitted. Must not throw or start a render synchronously. */
  submitted(): void;
  /** Discard frame-local preparation without consuming pending work. Idempotent. */
  discard(): void;
}

/** A renderer borrows its Gpu and immutable application data. */
export interface Renderer {
  readonly pending?: Promise<void>;
  /** Capture every input before asynchronous work; ordinary invalidation requests another frame. */
  capture(): CapturedFrame;
  readonly animating?: boolean;
  on?(event: 'invalidate', listener: () => void): () => void;
  destroy(): void;
}

/** Borrowed output. The caller owns its lifetime; GPU resources cannot cross devices. */
export interface RenderTarget {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  texture(): GPUTexture;
}

export interface RenderView {
  readonly renderer: Renderer;
  readonly target: RenderTarget;
  readonly at?: number;
  readonly viewport?: Viewport;
}

export interface RenderOptions {
  /** Complete drains bounded submissions. Use fixed sources for deterministic output. */
  readonly completion?: 'progressive' | 'complete';
  readonly views: readonly RenderView[];
  readonly timeMs: number;
  readonly signal?: AbortSignal;
  /** Synchronous final composition/copy commands on the same encoder. */
  readonly encode?: (encoder: GPUCommandEncoder) => void;
}

/** Managed targets enroll their texture in the frame's lifetime without widening the public contract. */
export const targetResources = new WeakMap<RenderTarget, () => TextureResource>();
