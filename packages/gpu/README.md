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
for await (const native of frame.fields({
  source: document,
  from: 'node',
  rows,
  fields: {
    position: layout, // FieldValues: native Column + Index + RowAxis
    color: { source: recording, from: 'node', field: 'temperature' },
    label: 'name',
  },
  ids: true,
})) {
  // Native text, numbers, vectors and lists remain native CPU views.
  if (native.columns.label.kind === 'text') {
    const label = textAt(native.columns.label, 0); // Imported from @latkit/model.
  }
  const pages = frame.upload(native, {
    select: ['position', 'color'],
    float64: 'relative',
  });
  // Only selected numeric fields are uploaded. Labels use frame.text().
}
```

`FieldBinding` selects one named field from a borrowed `Queryable`. String inputs use the
request's `source` and `from`. The source supplies authoritative row identity when `rows` is
omitted or uses IDs. Already indexed physical selections can resolve application-owned
`FieldValues` without a source query. The source remains explicit; no synthetic source is needed.

`frame.fields` returns `NativeFields`. `frame.upload` returns `GpuPage` descriptors. Text and
control lists can stay entirely on the CPU. Matching native slices share backing arrays; sparse
or reordered inputs require bounded gathering. `retain()` keeps native allocations admitted to
GPU's CPU budget when picking or geometry needs them after preparation. Release that lease when
replacing the retained view. It does not acquire or close a model source.

Every binding must match the authoritative `Index` (document, type, index version). Explicit
binding `rows` declares partial overlay coverage. Outside that coverage, presence is false;
inside it, omitted observations are an error. Presence and validity are independent: a present
null is not a missing row. ID selections require native resolution.

A `window` requests native sample tiles. Static columns broadcast over the sample axis with no
expanded arrays. Sampled bindings must have identical absolute frames and coordinates; there
is no implicit interpolation. At least one sampled binding must cover the full requested rows.
Omit `window` for static values and sampled fields at the current frame coordinate.

```ts
const scale = await frame.scale({
  source: recording,
  from: 'node',
  rows,
  field: 'temperature',
  domain: { window: { kind: 'frames', offset: firstFrame, count: 120 } },
  range: [8, 2],
});
const radius = scaleValue(value, scale);
const uniforms = scaleParameters(scale, gpuField);
// WGSL: scaleShader() + scaleMapped(value, valid, scale, fallback)
```

`Scale`, `ColorScale`, `Position2D`, and their resolution semantics belong to GPU. Null,
nonfinite input and empty domains return the missing-value fallback; constant domains map to
the range midpoint. Ranges may descend. `scaleParameters` rebases domains against the uploaded
field's Float64 origin before narrowing. `frame.extent` is the lower-level indexed extent query;
`frame.scale` handles resolution and mapping together. Compatible native extents and aggregates
reuse the shared read cache.

Static fields survive append/evict invalidations independently of sampled values. Schema and
replacement changes invalidate affected caches. Fresh queries in one frame must agree on source
version. Retain sources explicitly for deterministic multi-query export; GPU never acquires or
closes them implicitly. Connected acquisitions use this exact `Queryable` path.

## History summaries

```ts
for await (const block of frame.envelope({
  source: recording,
  query: {
    kind: 'envelope',
    from: 'node',
    select: ['temperature'],
    rows,
    window: { kind: 'range', between: [100, 200], context: { before: 1, after: 1 } },
    buckets: 1200,
  },
})) {
  const pages = frame.upload(block, { select: ['temperature'] });
}
```

`EnvelopeBlock` belongs to model. Each row/bucket contains first, minimum, maximum and last
finite observations, their exact native coordinates and absolute frames, and a continuity bit.
Duplicate slots are valid; consumers deduplicate and order them by frame. Null/nonfinite
observations mark a discontinuity. Empty buckets remain invalid. Exact hit testing refines raw
samples; a summary is not a replacement observation.

Sources advertising `envelope` provide their own indexed reductions. Otherwise GPU streams raw
samples into bounded summaries and caches the result. The fallback bounds row/bucket working
storage, not source I/O: it still reads the requested history and rebuilds changed windows.
A single row's bucket summary must fit the configured block/staging budget or the fallback
rejects `resource-limit`; native sources can tile both axes. Choose bucket count from visible
resolution. Native source-side summaries are needed to avoid transferring long remote histories.

`GpuEnvelopeField` exposes values, coordinates, frames, and continuity through the same field
shader/table. Coordinate and frame buffers always use relative encoding; native Float64 arrays
remain authoritative for exact identity. There is no transport-specific summary format.

`frame.query(source, query)` also supports ordinary rows, samples, topology and aggregates.
Its bounded multicast cache applies backpressure. Optional `validate: true` adds model boundary
validation; header consistency, byte bounds, index identity and upload shape checks always run.

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

`GpuPage` exposes native index/rows, local row offset, named `GpuField` descriptors, one bind group, and optional absolute sample frame metadata. `GpuField` is discriminated by `kind`: envelopes expose the four descriptors described above; a value descriptor exposes its slot, physical type, component count, and optional Float64 origin; a list descriptor exposes the parent slot and an `items` value descriptor. Shader access uses `fieldPresent`, `fieldValid`, `fieldFloat`, `fieldInt`, `fieldUint`, `fieldBool`, `fieldVec2f/3f/4f`, and `fieldRow`. Value loads require valid local row/frame/component addresses; check masks before using values. Sample coordinates have their own slot and are addressed with row zero.

The layout uses three read-only storage bindings regardless of field count: a descriptor table and two payload banks. Normal columns stay in shared slab allocations. If independent resident columns span more banks, a bounded GPU copy consolidates the page before render passes in the same command submission. Consolidated pages are cached. There is no per-field bind group or public legacy raw-column path.

- Float32, Int32 and Uint32 slices upload directly where their span is economical. Integer fields remain integer data.
- Float64 requires an explicit `relative` or `float32` policy. Relative encoding subtracts a per-page, per-component Float64 origin before narrowing. Rebase camera/domain parameters against that origin in JavaScript Float64 too. Finite overflow rejects `precision`.
- Sample coordinates always use relative encoding. Their origin is independent of value origins.
- Vectors retain components, booleans remain bit-packed, validity and overlay presence remain distinct. Nonfinite observations are not null sentinels.
- Static lists of non-nullable numeric scalars or vectors retain native offsets and child spans. Use `fieldListLength(slot, row)`, `fieldListFloat(slot, row, item, lane)`, or `fieldListVec2f(slot, row, item)` after checking parent masks. Float64 policy applies to list items too. Variable payload size participates in page admission; a single cell exceeding the bound rejects `resource-limit`. Nested lists, nullable items, and sampled lists are not supported by field upload.
- Text and other model columns remain available through native queries. Text content enters the shared text API below.

Pages and their buffers are read-only. They can share native allocations; do not mutate or destroy them. Paging removes the single-binding limit, not the total working-set limit. Renderers still select bounded visible data and implement their own culling/level of detail.

## Colors and colormaps

Colors use normalized, sRGB-encoded `RGBA` with straight alpha. `Colormap` is immutable data, shared across renderers. The root exports `colormaps` (46 lazy sample tables), `createColormap`, `reverseColormap`, `sampleColormap`, `colorCss`, `colormapCss`, `parseColor`, and `resolveColor`.

```ts
import { colormaps, colormapShader, colormapCss } from '@latkit/gpu';

legend.style.backgroundImage = colormapCss(colormaps.viridis, { direction: 'to right' });
// Pipeline layout includes gpu.colormapLayout at group 1.
const wgsl = colormapShader({ group: 1 }); // colormapColor(t), paletteColor(index)
// In prepare():
const colors = frame.colormap(colormaps.viridis);
// In encode():
pass.setBindGroup(1, colors);
```

CPU sampling, CSS legends, and WGSL use the same premultiplied RGBA8 rendering table. Continuous values clamp, cyclic values wrap with a closed seam, and categorical values select hard bins. WGSL returns straight RGBA; the output pass owns compositing. Authoring supports explicit colors, one-time callbacks, and stops interpolated in Oklab, sRGB, or linear-light sRGB. Palette textures and bindings reuse the existing GPU cache and remain protected through submission. No model transformation or renderer-specific palette cache is involved.

See [the color contract and catalog](../../docs/colormaps.md) for semantics, source provenance, regeneration, and usage. Pure color helpers work without a DOM or a WebGPU device; `resolveColor` is the explicit DOM boundary. Bundlers can omit the entire unused catalog and color parser; accessing catalog metadata does not decode samples.

## Cameras, effects and input

`Camera2D` uses `center`, independent positive `scale` values, and `yDirection`. `fitCamera`,
`cameraPoint`, `worldPoint`, and `zoomCamera` use local CSS pixels. Diagrams can keep equal aspect;
monitors can scale coordinate and value axes independently. Network's geographic/3D projection
remains network geometry policy.

`Shade` defines `shade(ShadeFragment)`, with common color, pixel position, and scalar value.
`frame.shade()` binds pointer, viewport, presentation time and sixteen vec4 parameters through
`shadeShader()`. `outputShader()` and `premultipliedBlend` apply alpha once at the output boundary.
Renderers own effect pipeline compilation and call `Shade.tick` to update parameters/animation.

`createCanvasInput`, `localPoint`, `wheelDelta`, and `inputModifiers` share DOM mechanics.
`HoverOptions`, `HoverState`, `ContextMenu`, and `withinBudget` share payloads and cooperative work
limits. Interrupted picking never publishes a partial result. Geometry-specific hit tests,
gestures and hover suspension policy remain renderer responsibilities. No DOM event escapes in
a public context-menu payload.

## Shared strokes

`clipStroke(a, b)` clips homogeneous endpoints against WebGPU near/far planes and positive W, returning the visible parameter interval or `null`. `strokeShader()` supplies the matching `stroke_clip`, round-cap `stroke_distance`, and pixel-space `stroke_dash` helpers. Renderers own connectivity and path layout; these helpers keep clipping, widths, and hit geometry consistent without creating another rendering owner.

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

Network, monitor, and video use this foundation directly. Diagram retains a root-only public skeleton; its older implementation is isolated in `diagram/legacy`. Geometry, routing, culling, axis formatting, exact picking, and video encoding remain renderer-specific. Shared types, composition, and plumbing come from model/GPU without compatibility exports.

## Progressive native preparation

`gpu.query`, `gpu.fields`, and `gpu.envelope` use the same engines and caches as their frame methods.
Their iterators outlive individual render frames, borrow immutable native blocks, respect cancellation
and source closure, and apply pull-based backpressure. Consume or return each iterator. Native
`fields` tiles carry authoritative source `versions`; optional `at` supplies a point coordinate.
Only `frame.upload` creates frame-scoped GPU descriptors. Keeping a native iterator open is not
retaining a recording acquisition; applications explicitly retain sources when a fixed view is needed.

Renderers can expose `pending`, the next drawable work or completion, and notify `invalidate` when
work arrives. `gpu.render({ completion: 'complete', ... })` drains bounded submissions until the
participating renderers have no pending work. The final `encode` callback runs once, after completion.
Cancellation interrupts waiting without invoking that final callback. Use stable sources and fixed
time for deterministic output. `createCanvasView` remains progressive and event-driven.

`scaleParameters(scale, { origin })` takes an explicit scalar origin. For vector or envelope fields,
pass the corresponding `field.origin[component]`; one origin cannot represent every component.
`frame.shade({ timeMs })` can freeze effect time across progressively composed batches.

## Composed views

`createComposition({ gpu, views, background })` returns a regular `Renderer`.
Each view supplies a renderer and a normalized `region: { x, y, width, height }`
with a top-left origin. Later views overlay earlier views using premultiplied alpha.
Children receive their actual panel dimensions and the parent's coordinate and time.

Composition borrows children and owns only reusable panel textures and subscriptions.
The same frame preparation, uniform allocation, texture lifetime, encoder, and single
submission cover the whole tree. Complete rendering drains progressive child work;
interactive rendering forwards child invalidation and animation. GPU rendering locks
all descendants against concurrent preparation. Destroy compositions separately from
their children. A renderer may occur only once in a composition tree.
