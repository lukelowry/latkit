# @latkit/monitor

WebGPU signal monitor for Latkit.

`@latkit/monitor` renders one selected signal from a packed time series into a
caller-owned canvas. It is designed for append-heavy data:
load a series once, mutate or replace the value buffer as frames commit, and call
`extend()` to paint only the new frontier.

## Install

```sh
npm install @latkit/gpu @latkit/monitor
```

## Basic use

```ts
import { requestDevice } from '@latkit/gpu';
import { createMonitor, type Series } from '@latkit/monitor';

const device = await requestDevice();
const canvas = document.querySelector<HTMLCanvasElement>('#monitor')!;
const monitor = await createMonitor(device, canvas, {
  valueRange: [0, 1],
  colormap: (t) => [t, 0.5, 1 - t],
});

const series: Series = {
  time: Float64Array.from([0, 1, 2]),
  values: new Float32Array([0.1, 0.4, 0.2, 0.5, 0.3, 0.6]),
  signalCount: 1,
  elementCount: 2,
};

monitor.load(series);
```

`createMonitor()` accepts a native Core `GPUDevice`; `@latkit/gpu` acquires the
device and supplies Monitor's shared presentation internals. The monitor borrows
the device and canvas while owning its presentation and renderer resources. This
makes one device safe to share across monitors:

```ts
const overview = await createMonitor(device, overviewCanvas);
const detail = await createMonitor(device, detailCanvas);

// On teardown, release every borrower before its device owner.
overview.destroy();
detail.destroy();
device.destroy();
```

`destroy()` unconfigures WebGPU and restores the canvas's original size
attributes. It never removes the canvas or destroys the shared device.

`Series.values` is signal-major:

```ts
values[signal * time.length * elementCount + frame * elementCount + element];
```

Use `setSignal()` to switch signals, `setFocus()` to highlight one element, and
`on('hover', ...)` / `on('pick', ...)` to inspect the nearest reading under the
pointer. Call `destroy()` before removing or reusing the canvas.
