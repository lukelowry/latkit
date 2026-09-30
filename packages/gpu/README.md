# @latkit/gpu

Shared WebGPU plumbing for native Latkit data. This package replaces the previous GPU package outright. It has no `Series`, channel controller, device-pool facade, renderer scene format, or compatibility entry point.

Import the public API from `@latkit/gpu`. Renderers own geometry, layout, cameras, styles, interaction, and source subscriptions. Applications own model acquisitions. GPU resources and frame execution belong to `Gpu`.

```ts
import { createGpu, createRenderTarget } from '@latkit/gpu';

const gpu = await createGpu({
  budget: {
    cpuBytes: 64 * 1024 ** 2,
    gpuBytes: 256 * 1024 ** 2,
    stagingBytes: 16 * 1024 ** 2,
  },
});
const target = createRenderTarget({ gpu, width: 1920, height: 1080 });

// A renderer implements the interface below and borrows this Gpu.
await gpu.render({
  timeMs: 500,
  views: [{ renderer, target, at: 12.5 }],
  signal,
});

await gpu.idle();
renderer.destroy();
target.destroy();
gpu.destroy();
```

`at` uses the model axis units. `timeMs` is presentation animation time. Each view may have a different coordinate. `FrameInfo.width/height` are physical target pixels; `viewport` describes logical pixels and display scale. Offscreen views default to one logical pixel per target pixel.

## Rendering contract

```ts
interface Renderer {
  prepare(frame: Preparation): Promise<void>;
  encode(frame: Encoding): void;
  destroy(): void;
}
```

Preparation acquires data, pipelines, and resources. Encoding is synchronous, may create render and compute passes on the supplied encoder, and never submits. `Gpu.render` prepares all requested views, checks coherence, then encodes them in order and submits once. Its optional `encode` callback appends composition or copy commands to the same encoder.

Queries must be exhausted or explicitly returned before preparation resolves. Preparation methods and GPU page descriptors are frame-scoped. Do not store them for use by later frames; requesting the same data again reuses resident resources. Input descriptors, model blocks, and published application field values must remain immutable.

One renderer represents one view. Concurrent use of the same renderer rejects `busy`; separate views can prepare concurrently. Cancellation interrupts shared-read consumers independently. An uncooperative renderer remains busy until its own preparation settles, preventing a later call from racing its state. Failed or cancelled preparation never submits a partial frame. Already submitted commands cannot be cancelled.

`render()` resolves after submission. `idle()` waits for managed submissions already in flight. Resource pins remain until queue completion. The owner bounds in-flight submissions (default two), and uses distinct ranges or copy-on-write allocations for data that must coexist.

The executable [browser fixture](tests/browser/check.js) demonstrates complete compute, render, uniform, and readback implementations.

## Native data and identity

`FieldBinding` is `FieldSelection` plus a borrowed `Queryable`. It carries no lifecycle. A renderer reads it directly:

```ts
const { source, ...selection } = binding;

for await (const block of frame.query(source, {
  kind: 'rows',
  ...selection,
  at: frame.at,
})) {
  if (block.kind === 'schema') {
    // This header is authoritative for this iteration.
    continue;
  }

  const pages = frame.upload(block, {
    select: selection.select,
    float64: 'relative',
  });
  // Build this frame's bindings/draws from pages.
}
```

`frame.query` preserves query-specific result types and accepts every current model query kind. It does not reinterpret document or recording ownership. A remote `Queryable` from `@latkit/connect` works identically; connect is only a test dependency here.

Equivalent requests from the same acquisition share a bounded stream and cached native blocks. Small selections are keyed by value; typed selections and arrays longer than 64 items use immutable object identity, avoiding a scan or serialization of large index arrays on every frame. Distinct acquisitions are never deduplicated by matching version strings. Concurrent consumers apply backpressure to each other; one consumer leaving does not cancel the others. Completed prefixes are replayable while resident. Once a prefix is evicted, a later reader starts its own query.

Each query must emit one coherent header/version. All queries from the same source in a frame must agree on that version. Later live appends do not invalidate immutable results already acquired. A new query observing another version rejects that frame with `conflict`; the controller may retry. Retain sources explicitly for deterministic export across many frames. No retention acquisition is created implicitly and no supplied source is closed.

Source publications conservatively invalidate cached requests for subsequent reads. Controllers subscribe to source changes and request redraws. The shared cache does not impose playback or redraw policy. All model query validation can be enabled with `validate: true`; header coherence, byte bounds, and GPU upload shape checks are always enforced.

`Index` and `RowAxis` remain native. `assertIndex` checks document, type, and index version. Ranges require no row array; sparse pages supply a GPU row map. Equal array lengths never imply identity. `FieldValues` accepts application-owned numeric, vector, or boolean columns with explicit row identity. `frame.values()` uploads them under the `value` field without fabricating a model query. `DataHit` supplies the same source/index/row vocabulary for renderer-specific picking.

## GPU columns

`GpuPage` describes bounded device-local pages. It preserves source index, physical row order, the row position within the input block, and absolute sample frame numbers. Numerical bindings use scalar offsets/strides and separate validity bitmaps. Numeric vectors preserve components. Boolean values remain packed bits; their offsets/strides use bit units. `columnShader` provides shared addressing and bit tests. Renderers declare their own storage bindings and geometry record layouts.

- Float32, Int32, and Uint32 slices upload directly where their stride/span is economical and fits a binding. Integers are never narrowed to Float32.
- Float64 value columns require an explicit `relative` or `float32` policy. Relative encoding subtracts a per-page, per-component Float64 origin before narrowing. Finite overflow rejects `precision`; it never silently becomes infinity. Source payload remains authoritative for exact readout.
- Sample coordinates always use relative encoding. Their origins are independent of viewport and style domains.
- Nulls remain validity bits. Nonfinite sampled values remain numerical observations and are not used as null sentinels. Rendering policy decides how to display them.
- Oversized or excessively padded numeric tiles are packed into bounded pages. Boolean values remain bit-packed. Unsupported text/list uploads reject; those columns still flow through `frame.query` for renderer-specific preparation.

Cached GPU input bindings are read-only. Do not write them from shaders or call native `destroy` on their buffers. Native buffers can contain unrelated suballocations; always respect the returned binding offset and size.

Geometry-specific culling and level of detail remain renderer responsibilities. Paging removes the single-binding size requirement; it does not make a working set larger than the entire budget renderable at once. Select a bounded working set or process explicit batches.

## Mutable data and owned resources

`BufferData` provides mutable renderer bytes with a bounded dirty-range journal. `TextureData` does the same for `r8unorm` and `rgba8unorm` pixel rows, covering glyph atlases, colormaps, and images without prescribing text rasterization or color semantics.

```ts
const layout = new BufferData({ size: 8192 });
layout.write({ offset: 4000, data: new Float32Array([x, y]) });
const binding = frame.buffer(layout);

const atlas = new TextureData({ width: 512, height: 512, format: 'r8unorm' });
atlas.write({ x, y, width, height, data: glyphPixels });
const texture = frame.texture(atlas);

const uniform = frame.uniforms(new Float32Array([scale, offset, 0, 0]));
```

Create persistent data outside preparation. After editing `bytes` directly, call `touch`. Each consumer tracks its own revision; there is no globally cleared dirty flag. Unchanged data is reused, dirty regions update when safe, and data still referenced by a frame uses copy-on-write. Mutating data during preparation rejects the frame. Uniform contents are dedicated to the frame, so successive views cannot overwrite earlier draw parameters.

`gpu.buffer(descriptor)` and `gpu.texture(descriptor)` allocate explicitly owned native working/output resources. Pass them through `frame.buffer` or `frame.texture` when encoding will use them, including resources used in the final encode callback. Call their wrapper's `destroy`, which releases the owner while preserving submitted frame references. Native device operations remain available for specialized work; directly allocated resources and external targets are outside the managed budget and remain the caller's responsibility.

Managed textures support the uncompressed formats listed in `resources.ts`, including common color and depth formats. Unsupported formats reject instead of receiving guessed memory accounting. Native validation and device feature requirements still apply.

## Budgets and device lifetime

Defaults are 64 MiB cached CPU data, 256 MiB managed GPU storage, 16 MiB temporary staging, and 4096 cache entries. Pages and query blocks default to at most 1 MiB, constrained further by device and configured limits.

CPU accounting deduplicates whole borrowed backing allocations and charges metadata estimates. Tiny slices of disproportionately large backing may be copied into bounded allocations; ordinary fitting native blocks remain borrowed. Numeric conversion, bitmap padding, and bounded copies consume staging budget. GPU accounting includes complete buffer slabs, unused slab capacity, working/output buffers, textures/mips/samples, and resources still referenced by submitted work. GPU pressure evicts eligible GPU cache entries rather than discarding unrelated query data.

These are managed allocation bounds, not process memory or driver-memory measurements. Application-owned `BufferData`/`TextureData`, model storage, external native objects, browser canvas storage, JavaScript engine overhead, and opaque pipeline/driver allocations are outside the byte totals. Pipeline cache entries are count-bounded. Texture byte accounting is texel-based; implementation-dependent depth storage is conservative.

`stats()` exposes allocation, query, cache-hit, upload, staging, submission, eviction, and peak counters. A compatible Float32 upload may require no extra JavaScript numeric copy; CPU-to-GPU transfer still occurs. `trim()` evicts unpinned caches. Admission rejects `resource-limit` when the live working set cannot fit; it never silently discards requested rows or exceeds the configured bound.

An explicitly supplied `GPUDevice` is borrowed; a requested device is owned. Required native features and limits are checked or requested at creation. One `Gpu` represents one device generation. Loss cancels pending preparation, invalidates resources, and is exposed through `lost`. Recreate owners and renderer resources explicitly for recovery; old native handles never silently move to another device.

## Canvas and worker use

`createPresentation({ gpu, canvas })` configures HTML or offscreen canvas output. It owns configuration/backing-size changes and restores them on destruction. `createRenderTarget` owns a resizable texture target. Both implement the same borrowed `RenderTarget` contract.

`createCanvasView({ gpu, canvas, renderer, onError, onLost })` adds DOM observation and coalesced animation-frame scheduling. `request({ at, timeMs })` updates the requested coordinate/time; omitted fields preserve their previous settings. `request()` redraws. Canvas resizing waits until preparation completes, preserving the displayed frame while data is loading. `pause`, `resume`, and `destroy` govern only scheduling/presentation. Device loss is reported to the host. The renderer, Gpu, and model sources remain independently owned. Worker/offscreen callers use `gpu.render` directly and need no DOM globals beyond WebGPU.

## Validation and remaining migration

```sh
pnpm --filter @latkit/gpu typecheck
pnpm --filter @latkit/gpu build
pnpm --filter @latkit/gpu test
pnpm --filter @latkit/gpu test:browser
pnpm --filter @latkit/gpu benchmark
```

Browser checks require a Chromium executable; set `LATKIT_BROWSER` if it is not found automatically. They verify actual GPU computation/readback, nullable strided columns, Float64 rebasing, independent view uniforms, incremental pixel uploads, and one million rows. Reports go to `output/gpu-browser.json`. The 100k/1m/4m-row benchmark separately measures JavaScript plumbing with a byte-addressable fake device; those numbers are not GPU timings.

The renderer packages still require migration to this contract. Their old GPU imports intentionally fail. Model coverage/envelope queries are separate contract work; this package consumes the current model query surface and does not invent hidden substitutes. Rasterization, geometry packing, routing, culling, interaction, and video encoding remain outside this package.
