# @latkit/gpu

Shared WebGPU preparation and rendering for native Latkit data. Import the public API from `@latkit/gpu`.

Applications own model acquisitions. Renderers borrow those acquisitions and a `Gpu`, and own layout, geometry, cameras, styles, interaction, and redraw policy. `Gpu` owns managed resource budgets, residency, shared field and text preparation, and frame submission.

## One frame contract

```ts
const gpu = await createGpu();
const target = createRenderTarget({ gpu, width: 1920, height: 1080 });

await gpu.render({
  timeMs: 500,
  views: [{ renderer, target, at: 12.5 }],
  signal,
});
await gpu.idle();
```

`at` uses model axis units; `timeMs` is presentation animation time. Each view can have a different coordinate. Target dimensions are physical pixels; `viewport` describes logical pixels and display scale.

```ts
interface Renderer {
  prepare(frame: Preparation): Promise<void>;
  encode(frame: Encoding): void;
  submitted?(frame: FrameInfo): void;
  readonly animating?: boolean;
  on?(event: 'invalidate', listener: (change: Invalidation) => void): () => void;
  destroy(): void;
}
```

Preparation acquires data and resources. Encoding is synchronous and records passes on the supplied encoder. All views prepare before any encode, then submit together exactly once. The optional final `gpu.render({ encode })` callback appends composition/copy commands to that encoder. Renderers never submit the queue.

Use `submitted()` to publish the interaction/picking state corresponding to the displayed frame. It runs only after the entire frame submits. Notification failures are reported as a post-submission `AggregateError`; every view is notified and resource completion remains tracked. Notifications must not throw or synchronously start another render.

An invalidation of `refresh` requests a subsequent frame while allowing coherent acquired work to finish. `replace` cancels unsubmitted preparation. `createCanvasView` subscribes to these events and schedules ongoing `animating` frames. This keeps live appends from continually cancelling useful work. The renderer classifies its own source/style/interaction changes.

Preparation methods and GPU descriptors are frame-scoped. Exhaust or return query/field iterators, and await text preparation. Immutable input identities allow later frames to reuse resident resources. Submitted pins last until queue completion, including cancellation or post-submission callback failure. A renderer cannot prepare concurrently with itself; distinct views can. Uncooperative preparation remains busy until it settles.

## Unified fields

```ts
for await (const page of frame.fields({
  source: document,
  index,
  rows,
  fields: {
    position: 'position',
    radius: 'radius',
    color: { source: recording, from: index.type, field: 'temperature', rows: capturedRows },
    selected: selectionValues, // FieldValues: native column + Index + RowAxis
  },
  float64: 'relative',
})) {
  // page.columns.position.slot identifies this field in the shared shader table.
  // page.bindGroup binds every selected field, its masks, and physical row mapping.
}
```

`FieldBinding` selects one named field from a borrowed `Queryable`. String inputs use the request's default `source` and index type. Omit `source` when all inputs have explicit sources or are application-owned `FieldValues`. No synthetic source is needed for application layout data.

Fields batch compatible requests by acquisition, type, selection, and static/sampled dependency. Native block boundaries are aligned across sources without copying matching slices. Reordered or sparse inputs use bounded gathering where alignment requires it. Numeric uploads then use the same encoder as `frame.upload(block, options)` and `frame.values(values, options)`; these are entry points to one physical layout and cache, not renderer-specific formats.

Every input must match the draw `Index` (document, type, index version). Equal lengths do not establish identity. The draw `RowAxis` remains authoritative. Explicit binding `rows` define a partial overlay; rows outside that coverage have `fieldPresent == false`. Omitted coverage requires every draw row to be readable. Native uncaptured/expired/closed errors propagate. A present null has `fieldPresent == true` and `fieldValid == false`; missing observations are never fabricated. Prefer physical row selections for repeated overlays; ID selections require native resolution.

Static fields survive append/evict invalidations and retain their GPU columns independently of sampled values. Data/structure changes invalidate affected types; schema/replace invalidate all fields. Cache hits do not reinterpret an old static header as a new source version. Fresh queries from the same source in a frame must agree on their authoritative version. Changes during multi-query preparation can reject `conflict`; retained acquisitions provide deterministic export. GPU never implicitly retains or closes a source.

`frame.query(source, query)` supports every native model query, including topology and sampled tiles. Its bounded multicast cache applies backpressure to concurrent readers. `@latkit/connect` acquisitions use the identical contract; no renderer transport adapter exists. Model boundary validation is optional (`validate: true`); header consistency, byte bounds, identity and upload shape checks are always enforced.

## One shader layout

```ts
const module = gpu.device.createShaderModule({
  code: fieldShader({ group: 0 }) + rendererShader,
});
const layout = gpu.device.createPipelineLayout({
  bindGroupLayouts: [gpu.fieldLayout, viewLayout],
});

// Within encode():
pass.setBindGroup(0, page.bindGroup);
```

`GpuPage` exposes native index/rows, local row offset, named `GpuField` descriptors, one bind group, and optional absolute sample frame metadata. Each `GpuField` exposes its slot, physical type, component count, and optional Float64 origin. Shader access uses `fieldPresent`, `fieldValid`, `fieldFloat`, `fieldInt`, `fieldUint`, `fieldBool`, `fieldVec2f/3f/4f`, and `fieldRow`. Value loads require valid local row/frame/component addresses; check masks before using values. Sample coordinates have their own slot and are addressed with row zero.

The layout uses three read-only storage bindings regardless of field count: a descriptor table and two payload banks. Normal columns stay in shared slab allocations. If independent resident columns span more banks, a bounded GPU copy consolidates the page before render passes in the same command submission. Consolidated pages are cached. There is no per-field bind group or public legacy raw-column path.

- Float32, Int32 and Uint32 slices upload directly where their span is economical. Integer fields remain integer data.
- Float64 requires an explicit `relative` or `float32` policy. Relative encoding subtracts a per-page, per-component Float64 origin before narrowing. Rebase camera/domain parameters against that origin in JavaScript Float64 too. Finite overflow rejects `precision`.
- Sample coordinates always use relative encoding. Their origin is independent of value origins.
- Vectors retain components, booleans remain bit-packed, validity and overlay presence remain distinct. Nonfinite observations are not null sentinels.
- Text/list model columns remain available through native queries. Numeric field upload rejects them. Text content then enters the shared text API below.

Pages and their buffers are read-only. They can share native allocations; do not mutate or destroy them. Paging removes the single-binding limit, not the total working-set limit. Renderers still select bounded visible data and implement their own culling/level of detail.

## Shared text and atlas

```ts
// Keep this immutable run list while content/layout is unchanged.
const runs: readonly TextRun[] = [
  {
    text: 'Temperature',
    font: { family: 'Inter, sans-serif', weight: 500 },
    position: [12, 28],
    size: 14,
    color: [0.9, 0.95, 1, 1],
    anchor: 7,
  },
];

const metrics = await gpu.measureText(runs[0], { signal });
const pages = await frame.text({ runs });

// Build a text pipeline with gpu.textLayout and textShader({ group: 0 }).
// Its vertex shader transforms textVertex(vertex, instance).position.
// Its fragment shader returns textColor(uv, color).
for (const page of pages) {
  pass.setBindGroup(0, page.bindGroup);
  pass.draw(6, page.count);
}
```

GPU owns shaping/rasterization caching, an append-only monochrome distance-field atlas, instance geometry, and shader bindings. Atlas regions remain immutable while frames use them. New runs upload only their new rectangles through the same pixel writer as `TextureData`. Unchanged run lists share one geometry allocation across views. Renderer-local `anchor` identifiers let a shader transform text using dynamic layout buffers without rebuilding text geometry. Colors are straight RGBA inputs; `textColor` produces premultiplied output for one/one-minus-src-alpha blending.

The default `createTextRasterizer()` waits for requested fonts, uses Canvas2D to shape whole single-line runs (preserving kerning, ligatures and complex scripts), and supports HTML/OffscreenCanvas environments. Metrics and ink positions use em units and a left-origin alphabetic baseline, y down. The atlas rasterizes at 48 pixels per em and uses distance fields for scalable monochrome labels. Browser font fallback applies. It does not provide color emoji, rich text, line breaking, arbitrary text layout, or a glyph-ID shaping API. Those policies belong to renderers/applications; custom headless shaping can implement `TextRasterizer` through `createGpu({ text: { rasterizer } })`.

Text, font identity/direction, and optional font `revision` identify cached shaping. Change revision when replacing a loaded face. Runs must be bounded single lines; oversized runs reject `resource-limit` instead of allocating unbounded canvases. Long labels should be split or shortened by their layout owner. `measureText` uses the same cached rasterization as drawing. The default atlas page is 1024 pixels square and is configurable through `text.atlasSize`; atlas resources, metadata, geometry and staging participate in shared budgets.

## Resources and ownership

`BufferData` and `TextureData` hold application-owned mutable bytes with bounded dirty journals. Create them outside preparation; call `write`, or `touch` after direct changes. `frame.buffer` and `frame.texture` reuse unchanged contents, transfer dirty regions when safe, and use copy-on-write while earlier frames retain old revisions. Mutating a prepared resource before submission rejects the frame. `frame.uniforms` always allocates independent immutable frame contents.

`gpu.buffer` and `gpu.texture` create explicitly owned working/output resources. Enroll them through frame methods when encoding uses them, including final copy/composition commands. Destroy the wrapper to release ownership while preserving submitted references. External native allocations/targets remain the caller's responsibility.

`createPresentation` owns HTML/OffscreenCanvas configuration and backing size. `createRenderTarget` owns a resizable output texture. `createCanvasView` adds DOM size/DPR observation and coalesced scheduling, while borrowing renderer, GPU, and sources. Worker and deterministic video rendering use `gpu.render` directly. `CanvasView.request({ at, timeMs })` changes coordinates; omitted properties retain prior values. `pause`, `resume`, and `destroy` affect presentation/scheduling only.

Defaults are 64 MiB CPU cache, 256 MiB managed GPU memory, 16 MiB staging, 4096 cache entries, and two submissions in flight. GPU accounting includes full slab/texture allocations and in-flight storage. CPU accounting deduplicates borrowed backing buffers and estimates cache metadata. Oversized borrowed backing may require bounded compaction. JavaScript engine overhead, application/model-owned storage, external resources, canvas storage and opaque driver allocations are outside those totals. Working sets that cannot fit reject `resource-limit` without dropping requested rows.

`stats()` reports queries, cache hits, uploads, staged bytes, GPU consolidation bytes, allocation peaks, submissions and eviction. Zero numeric staging means no extra JavaScript numeric materialization; CPU-to-GPU transfer still occurs. `trim()` releases unreferenced caches and their dependencies. An injected device is borrowed; an internally requested device is owned. Device loss cancels preparation and invalidates the owner. Recreate GPU and renderer resources explicitly for recovery.

## Verification and migration

```sh
pnpm --filter @latkit/gpu typecheck
pnpm --filter @latkit/gpu build
pnpm --filter @latkit/gpu test
pnpm --filter @latkit/gpu test:browser --headed --keep-open
pnpm --filter @latkit/gpu benchmark
```

The browser fixture validates actual computation/readback, sparse nullable samples, Float64 precision, multiple views, incremental images, one million rows, fragmented field consolidation/reuse, ten simultaneous visual fields, and text pixels. Headed mode leaves an interactive three-view fixture visible with `--keep-open`. Set `LATKIT_BROWSER` for an alternative Chromium executable. Reports and screenshots go to `output/gpu-browser.json` and `output/playwright/gpu-foundation.png`. Fake-device benchmarks isolate JavaScript plumbing and are not GPU timings.

Network, diagram, monitor and video still require migration. They should directly use native model identity/query blocks, shared field/text preparation, and this frame lifecycle. Renderer-specific geometry, routing, culling, formatting, picking and video encoding stay in their respective packages. Model coverage/envelope queries remain separate contract work; GPU does not invent a substitute query or compatibility format.
