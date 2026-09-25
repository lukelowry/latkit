# @latkit/monitor

WebGPU traces over one class's recorded signals. Load a `Series` once; committed appends update the plot automatically. The same API reads memory, files, or remote results.

## Install

```sh
npm install @latkit/monitor @latkit/model @latkit/colormaps
```

## Basic use

```ts
import { colormap } from '@latkit/colormaps';
import { createSeries } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';

const series = createSeries({
  elementCount: 2,
  signalCount: 1,
  time: Float64Array.of(0, 1),
  values: Float64Array.of(0.1, 0.4, 0.2, 0.5),
});
const monitor = createMonitor({
  valueRange: [0, 1],
  colorRange: [0.2, 0.8],
  colormap: colormap('magma'),
});
monitor.load(series, 0);
await monitor.attach(document.querySelector<HTMLCanvasElement>('#monitor')!);

series.append({
  resultId: 'run-1',
  classId: 'sensor',
  elementCount: 2,
  signalCount: 1,
  time: Float64Array.of(2),
  values: Float64Array.of(0.3, 0.6),
});
```

Initial arrays use `[signal][frame][element]` order. Appended batches use
`[frame][signal][element]` order, as a solver emits them. Both accept float32 or float64 values;
time is always float64. Published buffers are borrowed and immutable: create a new batch for
each append. No future timestamps or capacity slots are exposed.

`Series.read` returns a bounded window with a stride; the monitor handles this itself.
For file-backed or remote recordings, use `monitor.load(await results.series(classId), signalIndex)`.
The host owns the recording's resources.

## Display options

`setOptions` applies live patches; only `devices` is fixed at construction.
`OPTIONS` holds defaults and validation rules.

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
history behind the last image, which stays on screen, rescaled, until the replay completes.
History and focus textures are retained, and changing opacity only composites them again.

## Selection, events, and lifetime

```ts
monitor.setSignal(1);
monitor.select(42); // class element index, including sparse recordings
monitor.on('hover', (reading) => showReading(reading));
monitor.on('select', (reading) => inspect(reading.element));
monitor.on('valueRange', (range) => updateAxis(range));
monitor.on('rendered', () => hideProgress());
monitor.on('error', (error) => showError(error.message));
monitor.on('deviceLost', ({ message, recovering }) => {
  if (!recovering) showFallback(message);
});
```

`rendered` fires once everything committed is on screen, and never before the canvas has a layout
size: a canvas kept at `display: none` until `rendered` would wait forever. Pointer readings
preserve the original numeric value. A newer pick, load, or detach cancels stale reads.
`select(null)` clears selection. `pause()` stops work; `resume()` catches up. `clear()` drops the
loaded series. `detach()` releases the canvas while retaining data and settings; `destroy()`
releases the controller. See the
[lifecycle guide](https://latkit.readthedocs.io/en/latest/lifecycle.html).

## GPU checks

Run `pnpm --filter @latkit/monitor-example dev` and open
`http://127.0.0.1:5190/check.html` in a browser with WebGPU. The check reads actual pixels for
float64 normalization, clipping, nonlinear palettes, gaps, and focus opacity. It also captures
WebGPU validation errors. These complement the unit tests for read budgets, append scheduling,
and cancellation.
