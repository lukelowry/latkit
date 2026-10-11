---
'@latkit/monitor': minor
'@latkit/network': minor
'@latkit/video': minor
---

Stacked and outlined monitor plots, network restyles that reach laid-out vertices and laned edges, and video coordinates that wait for their data.

Added

- monitor: `tickLabels: false` keeps an axis's line and grid without tick labels or their room; `outline` closes the plot on the sides its axes leave open.
- video: `at` may resolve later, once the views are ready to draw its coordinate, and receives the export's signal. It is asked while the frame before encodes, so loading overlaps encoding.

Changed

- monitor: the plot leaves room only for what its axes write, from the options alone: an x axis without a label no longer reserves a label row. A tick offset ends its axis's tick labels, at the right of the x labels and atop the y labels, instead of joining the axis label.
- monitor: a tick offset is the window's start rounded down to a power of ten no smaller than its span, so it stays short and stands as the window moves; ticks fall on their step and move with the values. A negative offset reads `-600010`, not `+-600010`.
- monitor: an axis's `grid` and `tickLabels`, and `outline`, must be booleans.
- network: a new style draws over vertices layout placed and edges in lanes; they kept the old one.
