# @latkit/monitor

WebGPU traces over one class's recorded signals. Load one signal of a `Series`, such as a model's field, once; committed appends update the plot automatically. The same API reads memory, files, or remote recordings.

## Install

```sh
npm install @latkit/monitor @latkit/model @latkit/colormaps
```

## Basic use

```ts
import { colormap } from '@latkit/colormaps';
import { Series } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';

const series = Series.create({
  signals: ['load'],
  elementCount: 2,
  time: Float64Array.of(0, 1),
  values: Float64Array.of(0.1, 0.4, 0.2, 0.5),
});
const monitor = createMonitor({
  timeAxis: { label: 'Time (s)' },
  valueAxis: { label: 'Load (p.u.)', precision: 2 },
  valueRange: [0, 1],
  colorRange: [0.2, 0.8],
  colormap: colormap('magma'),
});
monitor.load({ series, signal: 0 });
await monitor.attach(document.querySelector<HTMLCanvasElement>('#monitor')!);

series.append({ time: Float64Array.of(2), values: Float64Array.of(0.3, 0.6) });
```

Initial arrays use `[signal][frame][element]` order. Appended frames use
`[frame][signal][element]` order, as a solver emits them. Both accept float32 or float64 values;
time is always float64. Published buffers are borrowed and immutable: create new arrays for
each append. No future timestamps or capacity slots are exposed.

`Series.read` returns a bounded window with a stride; the monitor handles this itself. A model's
field is a binding already, so a recorded signal loads as `monitor.load(field)`, from memory or
across a port. The host owns the recording's resources.

## Display options

`setOptions` applies live patches; only `devices` is fixed at construction.
`OPTIONS` holds each option's label, default, and validation rules.

```ts
monitor.setOptions({
  valueRange: null, // fit committed values
  colorRange: [0, 100], // keep colors comparable as the vertical axis changes
  timeRange: [20, 40], // null shows all committed time
  lineWidthPx: 2,
  focusColor: null, // brighten the selected trace's own color
  unselectedAlpha: 0.35,
});
```

`valueRange` controls geometry; `colorRange` controls the palette. A null color range follows the
vertical range. Values and times are normalized in float64 before GPU upload. Nonfinite values
break traces, and segments crossing the display boundary are clipped.

History reads stay within a 1 MiB sample budget, including time. Selected traces have their own
read window, so a wide class does not force tiny focus reads. When time and value mappings stay
fixed, appends draw only the new segments; an automatic value range keeps a tenth of its span
to spare and only grows, so most appends stay inside it. A changed mapping or canvas size replays
history behind the last image, which stays on screen, rescaled, until the replay completes. A
replay over more than two frames per device pixel draws each pixel column's extremes in the order
they occurred, so its drawing follows the canvas width, not the recording's length; appends and the
selected trace draw every frame, and readings come from the full series.
History and focus textures are retained, and changing opacity only composites them again.

## GPU axes and playhead

Ticks, gridlines, axis labels, and the playhead render into the same WebGPU output as the traces.
They are included in `snapshot()` and video exports. No SVG or HTML axis overlay is required.

```ts
monitor.setOptions({
  timeAxis: { label: 'Time (s)', minSpacingPx: 80 },
  valueAxis: { label: 'Voltage (p.u.)', format: 'fixed', precision: 2 },
  fontFamily: 'ui-monospace, monospace',
  fontSizePx: 12,
  textColor: [0.8, 0.82, 0.86, 1],
  axisColor: [0.5, 0.55, 0.6, 0.5],
  gridColor: [0.5, 0.55, 0.6, 0.15],
  cursorColor: [1, 0.7, 0.2, 0.9],
});
monitor.seek(3.5); // only the final GPU composition changes
monitor.seek(null); // hide the playhead

const point = monitor.toData(event.clientX, event.clientY);
if (point) console.log(point.time, point.value); // null in the axis gutters

monitor.setOptions({
  timeAxis: {
    label: 'Events',
    ticks: [
      { value: 0, label: 'Start' },
      { value: 5, label: 'Fault' },
    ],
    grid: true,
  },
});
monitor.setOptions({ timeAxis: null, valueAxis: null }); // a bare plot
```

An axis object replaces that axis's configuration; omitted top-level options remain unchanged.
Empty `ticks` draws no ticks. Custom ticks must be strictly increasing, with at most 128 entries;
labels accept at most 256 UTF-16 code units. Automatic ticks are bounded by the viewport and
thin overlapping or duplicate labels. Formats are `auto`, `fixed`, `scientific`, and `engineering`.
Labels use the shared monospace SDF atlas; complex script shaping is outside this text contract.
The host retains its canvas's accessible name, descriptions, and keyboard UI.

Label geometry changes only with the domain, options, or viewport. Stable gutters and caption bands keep numeric
changes from moving the plot. Automatic labels for narrow ranges far from zero show a shared
signed offset in the caption, preserving significant digits during deep zoom. Explicit numeric
formats and custom ticks retain their requested values. Gridlines remain visible through transparent trace pixels.
The shown and rebuilding history/focus textures together are bounded to 256 MiB and checked
against device limits. Upload slabs are reused across loads. Folded carry storage is bounded
by the active element chunk. Hover requests coalesce, with at most one in flight and a 1 MiB
cache for the latest sampled frame; an oversized frame is scanned in bounded chunks.

Web fonts refresh on `document.fonts.loadingdone`. Await `document.fonts.ready` before taking a
snapshot when the export must use a newly requested font. A snapshot copies prepared glyphs
and the resolved automatic domains, while borrowing the series. A worker never needs the DOM
or the source font to reproduce a captured view.

## Selection, events, and lifetime

```ts
monitor.load({ series, signal: 1 }); // another signal of the same series
monitor.select(42); // class element index, including sparse recordings
monitor.on('hover', (reading) => showReading(reading));
monitor.on('select', (reading) => inspect(reading.element));
monitor.on('contextmenu', ({ clientX, clientY, reading }) => openMenu(clientX, clientY, reading));
monitor.on('valueRange', (range) => showRange(range));
monitor.on('rendered', () => hideProgress());
monitor.on('error', (error) => showError(error.message));
monitor.on('deviceLost', ({ message, recovering }) => {
  if (!recovering) showFallback(message);
});
```

`rendered` fires once everything committed is on screen, and never before the canvas has a layout
size: a canvas kept at `display: none` until `rendered` would wait forever. Pointer readings
preserve the original numeric value. Only the primary button selects; a context menu, from the
pointer or the keyboard, suppresses the native one and reports the sample under the pointer, or
the one last hovered, as the network and the diagram report their parts. A newer pick, load, or
detach cancels stale reads.
`select(null)` clears selection. `pause()` stops work; `resume()` catches up. `load(null)` drops
the loaded series. `detach()` releases the canvas while retaining data and settings; `destroy()`
releases the controller. See the
[lifecycle guide](https://latkit.readthedocs.io/en/latest/lifecycle.html).

## GPU checks

Run `pnpm --filter @latkit/monitor-example dev` and open
`http://127.0.0.1:5190/check.html` in a browser with WebGPU. The check reads actual pixels for
float64 normalization, clipping, nonlinear palettes, gaps, and focus opacity. It also captures
WebGPU validation errors. These complement the unit tests for read budgets, append scheduling,
and cancellation.

## Video export

`snapshot()` captures a portable renderer-owned `Scene`: static data and style are copied; series remain borrowed. Pass snapshots to `@latkit/video`, which owns the worker, sample reads, rendering, and encoding.

```ts
import { exportVideo } from '@latkit/video';

const video = await exportVideo({
  views: [monitor.snapshot()],
  timeRange: [0, 10],
  width: 1920,
  height: 1080,
});
```

See [the video package](../video/README.md) for composition, streamed output, cancellation, and snapshot semantics. Advanced hosts can render a `Scene` against a `RenderTarget` through `createMonitorRenderer`; normal applications use `exportVideo`.

## Navigate and shade

```ts
monitor.setOptions({ interaction: true }); // drag, wheel, and two-pointer pinch
monitor.pan(40, 0); // move the plotted image by CSS pixels
monitor.zoom(1.25, { clientX: event.clientX, clientY: event.clientY });
monitor.zoom(0.8); // centered on the plot
monitor.fit(); // restore automatic time and value ranges

await monitor.setShade({
  wgsl: `fn shade(f: Fragment) -> vec4f {
    let pulse = 0.85 + 0.15 * sin(f.time * 2.0);
    return vec4f(f.color.rgb * pulse, f.color.a);
  }`,
  tick: () => true,
});
await monitor.setShade(null); // restore normal composition
```

Interaction is opt-in. A click selects; a drag never selects. Gestures start inside the plot,
leaving gutters and page scrolling elsewhere alone. Disabling interaction restores the canvas's
original touch policy. Hosts can use `pan`, `zoom`, and `fit` for accessible buttons or keyboard
bindings. Pan and zoom require an attached, prepared plot; explicit `setOptions` ranges also work
while detached. Nonfinite motion and nonpositive zoom factors throw; transforms that would
overflow or collapse a domain are ignored.

Movement remaps retained textures immediately, while axes and exact pointer readings use the
new displayed ranges. Obsolete history reads are aborted. After 120 ms without movement and
all pointers are released, the latest visible range is refined once. During refinement the old
image may be stretched, or leave newly exposed areas blank. Source reads and pixel folding
remain bounded by the existing window and GPU work budgets.

A shade runs over the composed trace image, including transparent plot pixels, independently
of signal count. Axes, labels, and playhead are drawn outside it. `Fragment` exposes straight
RGBA `color`, normalized plot `point` (time right, value up), canvas-local CSS `pixel`, and
`time` in seconds wrapping hourly. It does not expose sample values or element IDs: use the
colormap, selection, and exact readings for those. Returning alpha can also tint empty regions.
The renderer converts the returned straight color to premultiplied alpha for composition.

`tick(host, frame)` receives a reusable 64-float array (`u.host`, 16 vec4s in WGSL), plus
`timeMs`, CSS `viewport`, and nullable CSS `pointerPx`. `u.pointer_px` is far off-canvas when
no pointer is present. Return true to continue animation; otherwise the loop sleeps when idle.
Shader compilation is asynchronous. Failed builds reject with compiler diagnostics and leave
the last working shade and uniforms intact; newer requests supersede older builds. Detached
controllers compile on attach and report errors through the `error` event.

Snapshots copy WGSL and current host uniforms, freezing JavaScript tick hooks, as Network and
Diagram do. Video rendering advances the shader clock using output time; it does not serialize
or rerun application callbacks. The simulation playhead still follows source time.
