# Monitor

Plot sampled fields over a coordinate such as time. Live sources draw frames as they append.

```ts
import { createMonitor } from '@latkit/monitor';

const monitor = createMonitor(gpu, {
  canvas,
  source: observations,
  traces: { temperature: { from: 'sensor', field: 'temperature', widthPx: 1.5 } },
  camera: { window: [0, 30], values: [0, 100] },
  coordinateAxis: 'Time (s)',
  valueAxis: 'Temperature',
  at: 12,
});
```

`observations` is application-owned data supplying sampled numeric `sensor.temperature`. A trace draws one line per row; `rows`
narrows them. `at` places the playhead, and moving it never rereads history.

## Window

The camera is `{ window, values, fit, follow }`:

```ts
monitor.set({ camera: { window: [30, 60] } });
monitor.set({ camera: { fit: true } }); // values fit the data
monitor.set({ camera: { follow: 30 } }); // show the latest 30 as frames append
monitor.fit(); // every recorded frame
```

`detail: 'auto'` summarizes long histories with bounded envelopes; `'full'` reads every
observation. Gaps stay gaps.

## Inspect

Hover, click, and `pick` report exact observations as `Reading`s, never envelope values.
`monitor.select(rows)` highlights rows, each narrowed to one trace when it names a `field`.

[API](https://latkit.readthedocs.io/en/latest/api/reference/monitor/index.html)
