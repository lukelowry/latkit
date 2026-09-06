# Create a monitor

This tutorial creates a WebGPU monitor, loads a packed series, commits one frame, and listens for pointer readings.

## Create a canvas

The application owns the canvas and its layout:

```html
<canvas id="monitor" style="display: block; width: 100%; height: 360px"></canvas>
```

## Load a series

`Series.values` is signal-major:

```text
signal * frameCount * elementCount + frame * elementCount + element
```

The example below has one signal, four frames, and two elements.

```ts
import { colormap } from '@latkit/colormaps';
import type { Series } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';

const canvas = document.getElementById('monitor');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Missing #monitor canvas.');
}

const frameCount = 4;
const elementCount = 2;

const series: Series = {
  time: Float64Array.from([0, 1, 2, 3]),
  values: new Float32Array(1 * frameCount * elementCount),
  signalCount: 1,
  elementCount,
  validFrames: 0,
};

const monitor = createMonitor({
  valueRange: [0, 1],
  colormap: colormap('magma'),
});

monitor.load(series, 0);
await monitor.attach(canvas);

series.values[0 * frameCount * elementCount + 0 * elementCount + 0] = 0.25;
series.values[0 * frameCount * elementCount + 0 * elementCount + 1] = 0.75;
monitor.extend(1);
```

`createMonitor()` takes neither a device nor a canvas; `attach()` leases one from the shared pool and paints what the controller holds. See [Lifecycle and failures](lifecycle.md). `extend(1)` tells the monitor that frame `0` is ready to draw. Later calls commit more frames after you mutate or replace the values buffer; only the new segments are painted, and an auto-fit range (`valueRange: null`) grows from the newly committed frames alone.

## Change what is shown

Every display option is a live patch, and `setSignal` switches the displayed signal:

```ts
monitor.setOptions({ colormap: colormap('viridis'), lineWidthPx: 2, valueRange: null });
monitor.setSignal(0);
```

## Inspect readings

Pointer-down selects the nearest element itself; `select(element | null)` does the same programmatically without emitting:

```ts
monitor.on('hover', (reading) => {
  if (!reading) return;
  console.log(reading.element, reading.frame, reading.value);
});

monitor.on('select', (reading) => {
  inspector.show(reading.element);
});

monitor.select(null);
```

When the page removes the monitor, destroy the controller before removing its canvas:

```ts
monitor.destroy();
canvas.remove();
```

## Run the full example

The repository example streams synthetic signals, switches signal channels, ranks hot elements, and demonstrates selection:

```sh
pnpm --filter @latkit/monitor-example dev
```

Open `http://127.0.0.1:5190`.
