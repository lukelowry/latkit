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

A trace draws one line per row of its sampled `y` field; `rows` narrows them. `at` places the
playhead, and moving it never draws history again. [Views](views.md) covers what every view shares.

## Camera

The camera is `{ x, y, fit }`: the coordinates shown, the values shown, and whether the values fit
the data in `x`. Setting `y` turns `fit` off.

```ts
monitor.set({ camera: { x: [0, run.duration] } }); // a fixed window; frames draw as they arrive
monitor.set({ camera: { fit: true } }); // y fits the data in x
monitor.fit(); // every recorded frame, with fitted values
```

Each frame draws only what arrived since the last, so a fixed window streams at the cost of the new
frames. A new window or value range draws history again behind the shown image, at most
`limits.segmentsPerFrame` lines a frame, while the shown image stretches to the new axes. Advance a
moving window, such as the last minute, in steps rather than every frame.

A trace colored by a field recolors without drawing history again: a new `domain`, colormap, or
animated shade changes only how history composes. Gaps stay gaps, and a lone sample between them
draws as a dot.

## Inspect

Hover, click, and `pick` report exact observations as `Reading`s, one for each row whose line draws
near the pointer. A line is hit anywhere it draws, steps and width included, and the reading is the
recorded sample that part shows. Hover arrives a frame after the pointer moves, and draws nothing.

A reading selects its row, so clicking elsewhere on a selected line keeps it. A row is selected in
every trace of its type, or in one when the item names a `trace`. Selected lines draw over the rest
with a glow `selectedWidthPx` wide, and the rest fade to `unselectedAlpha`, 0.25 here. While
`selectedColor` is `'none'`, its default here, selected lines and their glow keep their own colors.

`fit(readings)` frames their coordinates and values. The monitor has no pointer navigation, so the
page keeps wheel and touch scrolling.

[API](https://latkit.readthedocs.io/en/latest/api/reference/monitor/index.html)
