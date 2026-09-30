# Create a monitor

> Migration note: this guide describes the earlier APIs. `@latkit/colormaps` has been removed; colors now belong to `@latkit/gpu`. See [colors and colormaps](colormaps.md), [network usage](network-quickstart.md), and the current package READMEs. Monitor and diagram are not migrated yet.

The application owns the canvas and its layout:

```html
<canvas id="monitor" style="display: block; width: 100%; height: 360px"></canvas>
```

## Load and append

Create an empty history and load one of its signals once. Each append publishes actual samples
and updates every subscriber, including the monitor.

```ts
import { colormap } from '@latkit/colormaps';
import { Series } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';

const canvas = document.querySelector<HTMLCanvasElement>('#monitor')!;
const series = Series.create({ signals: ['load'], elementCount: 2 });
const monitor = createMonitor({
  valueRange: [0, 1],
  colorRange: [0, 1],
  timeRange: [0, 10],
  colormap: colormap('magma'),
});
monitor.load({ series, signal: 0 });
await monitor.attach(canvas);

series.append({ time: Float64Array.of(0, 1), values: Float64Array.of(0.25, 0.75, 0.4, 0.6) });
```

Appends use `values[(frame * signals + signal) * elements + element]`. Their buffers remain
immutable after append. Float32 and float64 values are accepted; time is float64, finite, and
nondecreasing. Repeated timestamps are retained.

For a complete signal-major array, pass `time` and `values` to `Series.create`; its initial layout
is `[signal][frame][element]`. A recorded signal of a model loads as its field, from memory or
a remote recording: `monitor.load(field)`. The renderer reads bounded windows.

## Change the display

```ts
monitor.setOptions({
  colormap: colormap('viridis'),
  lineWidthPx: 2,
  valueRange: null,
  colorRange: [0, 1],
});
monitor.on('valueRange', (range) => updateAxis(range));
```

`valueRange` fits the vertical axis; `colorRange` fixes the palette independently. Null ranges
use automatic fitting, with a null color range following the vertical range. Appends inside the
current mapping draw only new segments. A new mapping or canvas size repaints the history behind
the last image, which stays on screen, rescaled, until the repaint is complete.

## Inspect and clean up

```ts
monitor.on('hover', (reading) => {
  if (reading) console.log(reading.element, reading.frame, reading.value);
});
monitor.on('select', (reading) => inspector.show(reading.element)); // the primary button alone
monitor.on('contextmenu', ({ clientX, clientY, reading }) => menu.open(clientX, clientY, reading));
monitor.on('error', (error) => showError(error.message));
monitor.select(null);

// When the view is removed:
monitor.destroy();
canvas.remove();
```

Selection uses class element indices, including sparse recordings. Reads are cancelled when their
view is replaced or detached. See [Lifecycle and failures](lifecycle.md).

## Run the full example

```sh
pnpm --filter @latkit/monitor-example dev
```

Open `http://127.0.0.1:5190`.

## Axes and export

Axes render inside the GPU plot and are preserved by video exports:

```ts
monitor.setOptions({
  timeAxis: { label: 'Time (s)' },
  valueAxis: { label: 'Response (p.u.)', precision: 2 },
  gridColor: [0.5, 0.55, 0.6, 0.15],
});
monitor.seek(2.5);
const scene = monitor.snapshot();
```

Use `timeAxis: null` and `valueAxis: null` to reclaim the gutters for an unlabeled plot.
`monitor.toData(clientX, clientY)` uses the same rectangle as traces and ticks; points in a gutter
return `null`. The host still provides an accessible canvas name and any keyboard controls.

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

Navigation remaps retained history immediately and refines after the gesture settles. The same
ranges drive labels, exact readings, and snapshots. Interaction defaults to false; the host can
use the methods for keyboard controls. Shading changes only plot composition, with no history
reads. Snapshots preserve WGSL and freeze JavaScript tick uniforms; exported shader time follows
the output video clock. See the [package README](https://github.com/lukelowry/latkit/tree/main/packages/monitor)
for the fragment and lifecycle contracts.
