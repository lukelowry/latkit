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
import { requestDevice } from '@latkit/gpu';
import { createMonitor, type Series } from '@latkit/monitor';

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

const device = await requestDevice();
const monitor = await createMonitor(device, canvas, {
  valueRange: [0, 1],
  colormap: colormap('magma'),
});

monitor.load(series, 0);
series.values[0 * frameCount * elementCount + 0 * elementCount + 0] = 0.25;
series.values[0 * frameCount * elementCount + 0 * elementCount + 1] = 0.75;
monitor.extend(1);
```

`extend(1)` tells the monitor that frame `0` is ready to draw. Later calls can commit more frames after you mutate or replace the values buffer.

## Inspect readings

Use hover and pick events to connect the monitor to the rest of your UI:

```ts
monitor.on('hover', (reading) => {
  if (!reading) return;
  console.log(reading.element, reading.frame, reading.value);
});

monitor.on('pick', (reading) => {
  monitor.setFocus(reading.element);
});
```

When the page removes the monitor, destroy the renderer before removing its canvas, and release the application-owned device last:

```ts
monitor.destroy();
canvas.remove();
device.destroy();
```

## Run the full example

The repository example streams synthetic signals, switches signal channels, ranks hot elements, and demonstrates picking:

```sh
pnpm --filter @latkit/monitor-example dev
```

Open `http://127.0.0.1:5190`.
