# @latkit/monitor

Native sampled-data rendering on `@latkit/model` and `@latkit/gpu`. The root exports
`createMonitor`, `attachMonitorInput`, and their public types. This package has no dependency on
the old monitor implementation or a compatibility data format.

```ts
import { createMonitor, attachMonitorInput } from '@latkit/monitor';
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

monitor.on('select', (reading) => {
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
use `setData`, `setTrace`, or `setOptions` to publish changes. Styling a trace preserves the explicit coordinate window.
All traces share the displayed coordinate window and value domain; independently scaled signals
belong in separate monitor views sharing one GPU owner.

The monitor borrows the supplied sources and never closes them, mutates their buffers, or transfers
their backing. It owns bounded retained acquisitions for coherent dependent reads and reuses them
across matching history, resize, and focus work. Superseded acquisitions are released after their
active readers finish; destroying the monitor releases its remaining acquisitions.
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

Preparation uses bounded read-ahead of immutable native blocks. The queue admits at most 32
chunks, counts entire shared backing allocations once, and reserves space for the block currently
being produced. Its per-job cap is the smaller of 8 MiB, one eighth of the GPU CPU budget, and one
quarter of `historyBytes`. Oversized backing fails explicitly. Queued work is acknowledged only
after successful submission; failed frames replay the same geometry without losing observations.
Several chunks can be prepared per frame under one shared `prepareMs` target and
`segmentsPerFrame` observation limit. Sources apply backpressure at the queue capacity rather
than at every display frame. These are cooperative limits, not hard source/compiler deadlines.
The shared GPU owns field alignment, uploads, resource accounting, scales, colors, and text/atlas
storage. The monitor owns trace geometry, axes, history images, and submitted inspection coverage.

Initial history becomes visible after its first submitted batch, including a single observation.
Later batches add detail without clearing it. Changed mappings and styling retain the existing
presentation until their replacement is coherent. `stats().visible` reports a published image;
`pendingBytes` reports native backing and metadata currently held by read-ahead.

Committed history and focus use GPU-managed images. Resizing immediately scales both into the
new plot bounds, with axes laid out at the current CSS size. After 120 ms without another resize,
the monitor prepares sharper replacements. Replacement history, focus, domains, and picking change together
only after successful submission; cancelled replacements leave the committed presentation intact.
Ordinary pointer movement and playhead changes never rebuild history. Focus prepares only the
selected row using the same detail policy. `setWindow` explicitly requests another coordinate
interval; `setOptions({ valueDomain })` sets the value range. There is no camera or pan/zoom API.
`hitTest` separately reads a small coordinate interval, returning the nearest original observations
(default limit 16). It never reports envelope representatives as invented observations. Results
reject when the presented generation or source version changes during the read.

## Live updates and effects

Appends coalesce into pending frame intervals and never cancel active historical preparation.
With fixed domains and no follow, incoming preparation starts immediately when capacity permits,
reads only the new interval, and joins it to retained native boundaries. An empty source can start
streaming one observation at a time. Inspection accepts only submitted frame/row coverage.
Automatic domains grow by default; a changed domain rebuilds the image. `autoDomain: 'fit'`
recalculates the visible range. `follow: { span }` advances after bounded current work completes;
its moving domain still rebuilds the visible image. Retained geometry for inexpensive rolling
follow is a separate optimization. A source `replace` invalidates the old coverage and schedules
a coherent replacement. Exact automatic domain discovery can still require a full source scan.

Shared `Shade`, colormaps, straight-alpha colors, stroke helpers, numeric scales, text
runs and atlas resources are used directly. `setShade` compiles before replacing the working
pipeline. One effect time and parameter set is frozen across each progressive history generation.
Pointer position is sampled when an explicit history generation starts; moving the pointer does
not replay history. A flattened RGBA image cannot recover each observation's shade value. Animated effects refine
at history-generation cadence. They are not a constant-cost image postprocessing promise.

Input uses shared canvas normalization for click selection, context menus, Escape to clear focus,
and hover in local CSS coordinates. Hover uses a latest-pointer cadence instead of waiting for
pointer movement to stop. Exact repeated inspection can reuse a still-valid result. Wheel, touch scrolling and navigation keys retain browser
behavior. Dragging does not navigate or select. Automatic
hover suspends when its cooperative refinement budget is exceeded, without publishing partial
nearest results. `hover: 'off'` disables hover reads; explicit `hitTest` remains available.

Limits fail with `resource-limit`, never silently omit requested rows. `historyBytes` includes
images/MSAA storage, read-ahead and estimated boundary/coverage metadata; `pickingBytes` bounds retained result storage.
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
    encode: (encoder) => copyOutput(encoder, output.texture()),
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
pnpm --filter @latkit/monitor build
pnpm --filter @latkit/monitor typecheck
pnpm --filter @latkit/monitor test
pnpm --filter @latkit/monitor test:browser --headed --keep-open
```

Normal demo startup mounts the visible view immediately; checks run only from the explicit button
or the test runner. The demo includes a start/stop stream control.

The headed fixture verifies actual pixels for gaps, interpolation, Float64 precision, envelopes,
MSAA, sampled visibility, focus, connected sources, and custom shading. Successive-frame pixel
checks cover selected-image resizing, cancelled window replacements, and MSAA changes. It benchmarks 100,000 rows,
a million-observation history, and a multi-signal workload at 960 x 480. Timings include rendering
and queue completion, not display-vsync FPS. Browser background throttling is disabled for repeatable
measurements. Hardware, browser load, source work and data distribution still affect results.
The real-canvas test also measures first visible data, click-to-focus, and receive-to-visible
latency for 40 single-observation appends at an 8 ms cadence, checking canvas pixels on submission.
Reports and screenshots are written to `output/monitor-browser.json` and `output/playwright/monitor.png`.
The generated source bounds native blocks and does not allocate a complete history matrix.

`diagram_new` and `video_new` remain separate skeletons.
