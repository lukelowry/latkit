# @latkit/monitor_new

Native sampled-data rendering on `@latkit/model` and `@latkit/gpu`. The root exports
`createMonitor`, `attachMonitorInput`, and their public types. This package has no dependency on
the old monitor implementation or a compatibility data format.

```ts
import { createMonitor, attachMonitorInput } from '@latkit/monitor_new';
import { createGpu, createCanvasView, colormaps } from '@latkit/gpu';

const gpu = await createGpu();
const monitor = createMonitor({
  gpu,
  data: {
    source: recording, // Any sampled Queryable, including a connect acquisition.
    window: { kind: 'range', between: [0, 30] },
    traces: {
      temperature: {
        from: 'node',
        field: 'temperature',
        rows,
        color: { field: 'temperature', domain: [0, 100], colormap: colormaps.viridis },
        widthPx: 1.5,
      },
    },
  },
  options: {
    detail: 'auto',
    valueDomain: [0, 100],
    coordinateAxis: { label: 'Time (s)' },
    valueAxis: { label: 'Temperature' },
    hover: 'auto',
    hoverBudgetMs: 2,
  },
});
const view = createCanvasView({ gpu, renderer: monitor, canvas, onError });
const detach = attachMonitorInput({ monitor, canvas });
view.request({ at: 12 }); // Playhead; does not read the history again.

monitor.on('select', reading => {
  // source, version, index, physical row, field, absolute frame, coordinate, original value.
  application.select(reading);
});

// Each owner releases only its own resources.
detach();
view.destroy();
monitor.destroy();
gpu.destroy();
```

## Data and rendering

`Trace.field` accepts a sampled numeric field name or shared `FieldBinding`. Shared `FieldInput`
bindings supply color, visibility, and shading, including static columns, sparse overlays, and
aligned sampled sources. Native indices and frame coordinates must agree. Inputs are immutable;
use `setData`, `setTrace`, or `setOptions` to publish changes. Styling a trace preserves navigation.
All traces share the displayed coordinate window and value domain; independently scaled signals
belong in separate monitor views sharing one GPU owner.

The monitor borrows sources and never retains, closes, mutates, or transfers their buffers.
Native columns pass through GPU field resolution and upload. Float64 positions use per-component
floating origins; picking retains original Float64 coordinates, values, and absolute frames.
Uploading still transfers data to the device, and rebasing, joins, and sparse gathers may require
bounded materialization. There is no promise of zero copies across every transport or GPU boundary.

`detail: 'auto'` uses native first/minimum/maximum/last envelopes when observations exceed the
working display resolution. GPU supplies the same bounded reduction when the source lacks native
envelopes. Bucket resolution is capped by working-storage limits. Representatives are ordered
and deduplicated by absolute frame. Discontinuous rectangles refine native samples; missing or
nonfinite observations never become connecting lines. Sampled visibility and unrelated sampled
color/shade fields use aligned native samples. `detail: 'full'` requests every native observation.
Linear, step-before, and step-after interpolation are supported.

Preparation holds one native block per active history/focus job and acknowledges it only after
submission. Jobs yield between row batches and adapt batch sizes toward `limits.prepareMs`, with
`segmentsPerFrame` as a hard observation cap per job. The preparation time is a cooperative target,
not a hard deadline for a source implementation, compiler, or device driver. The shared GPU owns
query caches, field alignment, uploads, resource accounting, scales, colors, and text/atlas storage.
The monitor owns only its geometry, axes, history images, navigation, and exact reading policy.

Committed history uses GPU-managed images. Camera movement reprojects the committed image
immediately, then refines after 120 ms without navigation changes. No history query is needed for
the moving image or playhead. Focus prepares only the selected row using the same detail policy.
`hitTest` separately reads a small coordinate interval, returning the nearest original observations
(default limit 16). It never reports envelope representatives as invented observations. Results
reject when the presented generation or source version changes during the read.

## Live updates and effects

For a completed view with fixed mappings, append reads only new frames and joins them to retained
native boundary observations. Automatic domains grow by default; a changed domain rebuilds the
image. `autoDomain: 'fit'` recalculates the visible range. `follow: { span }` moves the coordinate
window on append. Eviction discards affected history and clamps to the retained coordinate range.
Changes during an unfinished generation coalesce into a fresh generation; rapid live updates can
defer full refinement. A stable retained acquisition is appropriate when completion is required.

Shared `Shade`, colormaps, straight-alpha colors, stroke helpers, independent `Camera2D` axes, text
runs and atlas resources are used directly. `setShade` compiles before replacing the working
pipeline. One effect time and parameter set is frozen across each progressive history generation.
Arbitrary data-dependent or pointer-dependent shading requires replaying history; a flattened RGBA
image cannot recover each original observation's shade value. Animated effects therefore refine
at history-generation cadence. They are not a constant-cost image postprocessing promise.

Input uses shared canvas normalization and capture. Drag/pinch/wheel navigation, keyboard
navigation, fit, click selection, context menus, and hover use local CSS coordinates. Automatic
hover suspends when its cooperative refinement budget is exceeded, without publishing partial
nearest results. `hover: 'off'` disables hover reads; explicit `hitTest` remains available.

Limits fail with `resource-limit`, never silently omit requested rows. `historyBytes` includes
images/MSAA storage and estimates boundary metadata; `pickingBytes` bounds retained result storage.
The shared GPU has its own cache/upload budgets. These are managed-resource estimates, not process
or driver memory measurements. `stats()` reports current work, history storage and hover state.

## Complete output

Applications own acquisition and output lifetimes. Progressive rendering is the default;
`completion: 'complete'` drains bounded submissions before the final composition callback.
Use a stable acquisition and a fixed presentation time for deterministic output.

```ts
import { createRenderTarget } from '@latkit/gpu';

const fixed = await recording.retain({ window });
const output = createRenderTarget({ gpu, width: 1920, height: 1080 });
const exportMonitor = createMonitor({ gpu, data: { source: fixed, window, traces } });
try {
  await gpu.render({
    views: [{ renderer: exportMonitor, target: output, at: coordinate }],
    completion: 'complete',
    timeMs: 0,
    signal,
    encode: encoder => copyOutput(encoder, output.texture()),
  });
  await gpu.idle();
} finally {
  exportMonitor.destroy();
  output.destroy();
  await fixed.close();
}
```

## Verification

```sh
pnpm --filter @latkit/gpu build
pnpm --filter @latkit/connect build
pnpm --filter @latkit/monitor_new build
pnpm --filter @latkit/monitor_new typecheck
pnpm --filter @latkit/monitor_new test
pnpm --filter @latkit/monitor_new test:browser --headed --keep-open
```

The headed fixture verifies actual pixels for gaps, interpolation, Float64 precision, envelopes,
MSAA, sampled visibility, focus, connected sources, and custom shading. It benchmarks 100,000 rows,
a million-observation history, and a multi-signal workload at 960 x 480. Timings include rendering
and queue completion, not display-vsync FPS. Browser background throttling is disabled for repeatable
measurements. Hardware, browser load, source work and data distribution still affect results.
Reports and screenshots are written to `output/monitor-browser.json` and `output/playwright/monitor.png`.
The generated source bounds native blocks and does not allocate a complete history matrix.

`diagram_new` and `video_new` remain separate skeletons; the old `monitor` package remains unmigrated.
