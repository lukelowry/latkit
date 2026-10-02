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

The camera is `{ window, values, fit }`:

```ts
monitor.set({ camera: { window: [0, run.duration] } }); // a fixed window; frames draw as they arrive
monitor.set({ camera: { fit: true } }); // values fit the data in the window
monitor.fit(); // every recorded frame, with fitted values
```

Each frame draws what has arrived since the last, so a fixed window streams at the cost of the new
frames alone. A changed window or value range redraws history behind the shown image, at most
`limits.segmentsPerFrame` lines per frame; meanwhile the shown image stretches to the new axes.
Setting `values` turns `fit` off; fitted values grow as data arrives. For a moving window, such as
the last minute, advance it in steps rather than every frame. Gaps stay gaps.

## Inspect

Hover, click, and `pick` report exact observations as `Reading`s; hover arrives a frame after the
pointer moves. `monitor.select(rows)` highlights rows, each narrowed to one trace when it names a
`field`, and fades the rest to `unselectedAlpha`. Selected traces keep their colors unless
`selectedColor` is set. `fit(readings)` frames readings once, and `reveal(reading)` moves the window
to one outside it. A click selects; the monitor has no pointer navigation, so the page keeps wheel
and touch scrolling. Selection, events, and the style options every view shares are under
[views](views.md).

[API](https://latkit.readthedocs.io/en/latest/api/reference/monitor/index.html)
