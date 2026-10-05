# Monitor

Plot sampled fields over a coordinate such as time. Live sources draw frames as they append.

```ts
import { createMonitor } from '@latkit/monitor';

const monitor = createMonitor(gpu, {
  canvas,
  source: observations,
  traces: { temperature: { from: 'sensor', y: 'temperature', widthPx: 1.5 } },
  camera: { x: [0, 30], y: [0, 100] },
  xAxis: 'Time (s)',
  yAxis: 'Temperature',
  at: 12,
});
```

`observations` is application-owned data supplying sampled numeric `sensor.temperature`. A trace draws one line per row
of its `y` field against the coordinate; `rows` narrows them. `color`, `widthPx`, `visible`, and `shade` are
[channels](topology-and-channels.md#channels). `at` places the playhead, and moving it never rereads history.

## Camera

The camera is `{ x, y, fit }`: the coordinates shown, the values shown, and whether the values fit
the data.

```ts
monitor.set({ camera: { x: [0, run.duration] } }); // a fixed window; frames draw as they arrive
monitor.set({ camera: { fit: true } }); // y fits the data in x
monitor.fit(); // every recorded frame, with fitted values
```

Each frame draws what has arrived since the last, so a fixed window streams at the cost of the new
frames alone. A changed window or value range redraws history behind the shown image, at most
`limits.segmentsPerFrame` lines per frame; meanwhile the shown image stretches to the new axes.
Setting `y` turns `fit` off; fitted values grow as data arrives. For a moving window, such as
the last minute, advance it in steps rather than every frame. Gaps stay gaps.

## Inspect

Hover, click, and `pick` report exact observations as `Reading`s; hover arrives a frame after the
pointer moves. `monitor.select(rows)` highlights rows, each narrowed to one trace when it names a
`trace`, and fades the rest to `unselectedAlpha`. Selected traces keep their colors while
`selectedColor` is `'none'`, its default here. `traceColor` and `traceWidthPx` set what a trace's
`color` and `widthPx` leave unset. `fit(readings)` frames readings once, and `reveal(reading)` moves the window
to one outside it. A click selects; the monitor has no pointer navigation, so the page keeps wheel
and touch scrolling. Selection, events, and the style options every view shares are under
[views](views.md).

[API](https://latkit.readthedocs.io/en/latest/api/reference/monitor/index.html)
