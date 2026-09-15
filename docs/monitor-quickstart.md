# Create a monitor

The application owns the canvas and its layout:

```html
<canvas id="monitor" style="display: block; width: 100%; height: 360px"></canvas>
```

## Load and append

Create an empty history and load it once. Each append publishes actual samples and updates every
subscriber, including the monitor.

```ts
import { colormap } from '@latkit/colormaps';
import { createSeries } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';

const canvas = document.querySelector<HTMLCanvasElement>('#monitor')!;
const series = createSeries({ signalCount: 1, elementCount: 2 });
const monitor = createMonitor({
  valueRange: [0, 1],
  colorRange: [0, 1],
  timeRange: [0, 10],
  colormap: colormap('magma'),
});
monitor.load(series, 0);
await monitor.attach(canvas);

series.append({
  resultId: 'run-1',
  classId: 'sensor',
  elementCount: 2,
  signalCount: 1,
  time: Float64Array.of(0, 1),
  values: Float64Array.of(0.25, 0.75, 0.4, 0.6),
});
```

Batches use `values[frame * signalCount * elementCount + signal * elementCount + element]`.
Their buffers remain immutable after append. Float32 and float64 values are accepted; time is
float64, finite, and nondecreasing. Repeated timestamps are retained.

For a complete signal-major array, pass `time` and `values` to `createSeries`; its initial layout
is `[signal][frame][element]`. For a file or remote result, load
`await results.series(classId)` directly. The renderer reads bounded windows.

## Change the display

```ts
monitor.setOptions({
  colormap: colormap('viridis'),
  lineWidthPx: 2,
  valueRange: null,
  colorRange: [0, 1],
});
monitor.setSignal(0);
monitor.on('valueRange', (range) => updateAxis(range));
```

`valueRange` fits the vertical axis; `colorRange` fixes the palette independently. Null ranges
use automatic fitting, with a null color range following the vertical range. Fixed mappings let
appends draw only new segments. Changing a mapping replays history.

## Inspect and clean up

```ts
monitor.on('hover', (reading) => {
  if (reading) console.log(reading.element, reading.frame, reading.value);
});
monitor.on('select', (reading) => inspector.show(reading.element));
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
