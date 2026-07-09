# Create a monitor

This tutorial creates a WebGPU monitor, loads a packed series, commits one frame, and listens for pointer readings.

## Create a host element

The monitor owns the canvas it inserts into your container:

```html
<div id="monitor" style="width: 100%; height: 360px"></div>
```

## Load a series

`Series.values` is signal-major:

```text
signal * frameCount * elementCount + frame * elementCount + element
```

The example below has one signal, four frames, and two elements.

```ts
import { colormap } from '@latkit/colormaps';
import { createMonitor, type Series } from '@latkit/monitor';

const container = document.getElementById('monitor');
if (!(container instanceof HTMLElement)) {
  throw new Error('Missing #monitor container.');
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

const monitor = await createMonitor(container, {
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

Call `monitor.destroy()` when the host page removes the monitor.

## Run the full example

The repository example streams synthetic signals, switches signal channels, ranks hot elements, and demonstrates picking:

```sh
pnpm --filter @latkit/monitor-example dev
```

Open `http://127.0.0.1:5190`.
