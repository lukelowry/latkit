import type {
  AggregateBlock,
  AggregateQuery,
  EndpointsBlock,
  EndpointsQuery,
  LinksBlock,
  LinksQuery,
  Query,
  QueryBlock,
  QueryHeader,
  Queryable,
  RowsBlock,
  RowsQuery,
  SamplesBlock,
  SamplesQuery,
} from '@latkit/model';
import type { TextRequest, TextPage } from './text.js';
import type { BufferResource } from './owned-buffer.js';
import type { BufferData } from './buffers.js';
import type { FieldValues, FieldsRequest } from './binding.js';
import type { GpuPage, UploadOptions } from './columns.js';
import type { TextureData } from './texture-data.js';
import type { TextureResource } from './resources.js';

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

export type QueryResult<Q extends Query> =
  | QueryHeader
  | (Q extends RowsQuery
      ? RowsBlock
      : Q extends SamplesQuery
        ? SamplesBlock
        : Q extends EndpointsQuery
          ? EndpointsBlock
          : Q extends LinksQuery
            ? LinksBlock
            : Q extends AggregateQuery
              ? AggregateBlock
              : QueryBlock);

/** Methods and returned GPU descriptors are scoped to this frame. Queries must be consumed or returned. */
export interface Preparation extends FrameInfo {
  readonly signal: AbortSignal;
  text(request: TextRequest): Promise<readonly TextPage[]>;
  fields(request: FieldsRequest): AsyncIterable<GpuPage>;
  query<Q extends Query>(source: Queryable, query: Q): AsyncIterable<QueryResult<Q>>;
  upload(block: RowsBlock | SamplesBlock, options: UploadOptions): readonly GpuPage[];
  values(
    values: FieldValues,
    options?: Pick<UploadOptions, 'float64' | 'maxPageBytes'>,
  ): readonly GpuPage[];
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

export type Invalidation = 'refresh' | 'replace';

/** A renderer represents one view and borrows its Gpu and sources. */
export interface Renderer {
  prepare(frame: Preparation): Promise<void>;
  /** Synchronous. Encode any number of passes; never submit the queue. */
  encode(frame: Encoding): void;
  /** Notification after whole-frame submission. Must not throw or start another render synchronously. */
  submitted?(frame: FrameInfo): void;
  readonly animating?: boolean;
  on?(event: 'invalidate', listener: (change: Invalidation) => void): () => void;
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
  readonly views: readonly RenderView[];
  readonly timeMs: number;
  readonly signal?: AbortSignal;
  /** Synchronous final composition/copy commands on the same encoder. */
  readonly encode?: (encoder: GPUCommandEncoder) => void;
}

/** Managed targets enroll their texture in the frame's lifetime without widening the public contract. */
export const targetResources = new WeakMap<RenderTarget, () => TextureResource>();
