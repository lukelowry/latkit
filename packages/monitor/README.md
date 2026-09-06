# @latkit/monitor

WebGPU signal monitor for Latkit: one controller, `Monitor`, and one registry, `OPTIONS`, that
names what it displays.

`@latkit/monitor` renders one selected signal from a packed time series into a caller-owned
canvas. It is designed for append-heavy data: load a series once, mutate or replace the value
buffer as frames commit, and call `extend()` to paint only the new frontier.

## Install

```sh
npm install @latkit/monitor @latkit/model @latkit/colormaps
```

## Basic use

```ts
import { colormap } from '@latkit/colormaps';
import type { Series } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';

const series: Series = {
  time: Float64Array.from([0, 1, 2]),
  values: new Float32Array([0.1, 0.4, 0.2, 0.5, 0.3, 0.6]),
  signalCount: 1,
  elementCount: 2,
};

const monitor = createMonitor({ valueRange: [0, 1], colormap: colormap('magma') });
monitor.load(series);

const canvas = document.querySelector<HTMLCanvasElement>('#monitor')!;
await monitor.attach(canvas);
```

The controller holds everything it is given; `attach` leases a shared device and paints it, and
`detach` keeps it for the next canvas. See the [lifecycle guide](https://latkit.readthedocs.io/en/latest/lifecycle.html).

`Series` is `@latkit/model`'s, so a series `collect` folds from a run loads unchanged. Its values
are signal-major:

```ts
values[signal * time.length * elementCount + frame * elementCount + element];
```

## Streaming

`extend(validFrames)` commits frames after you have written them in place; pass a replacement
buffer as the second argument when the buffer itself changed. Only the new segments are painted,
and an auto-fit value range grows from the newly committed frames alone.

```ts
series.values.set(frameValues, frame * series.elementCount);
monitor.extend(frame + 1);
```

## Options

Every display option is a live patch through `setOptions`; only `devices` is fixed at
construction. `OPTIONS` carries each option's default, validation kind, and whether it is live,
and `validateOptions` checks a patch before a device exists.

```ts
monitor.setOptions({
  colormap: colormap('viridis'),
  lineWidthPx: 2,
  valueRange: null, // fit the active signal's committed extent
});
```

## Selection and readings

`setSignal` switches the displayed signal, `select` highlights one element with a foreground trace
(`null` clears), and pointer-down selects the nearest reading itself. Every event carries one
payload:

```ts
monitor.on('hover', (reading) => (readout.textContent = reading ? String(reading.value) : ''));
monitor.on('select', (reading) => inspect(reading.element));
monitor.on('attached', (attached) => (canvas.hidden = !attached));
monitor.on('deviceLost', ({ message, recovering }) => !recovering && showFallback(message));
monitor.select(null);
```
