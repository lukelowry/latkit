---
'latkit': patch
---

Tiles never draw less than they did while what replaces them loads, a plot draws its axes with its first traces, and hovering a monitor of many traces probes only the points near the pointer.

- Fixed: as a trace of time tiles turned coarser, such as a live history growing or a window zooming out, it dropped the spans it drew before the coarser ones landed, which showed holes, blank stretches, and blocky bands. It now draws the finer spans until the spans that replace them land, and a trace draws finer frames that hold a whole bucket before a coarser placeholder. Vector tiles keep their finer tiles the same way while zooming out.
- Fixed: setting `view.sources` to tiles the view did not draw yet blanked the view until their first spans or tiles landed, about 100 ms. The view goes on drawing the sources before until each new `Tiles` can draw, then swaps them all in on one frame, as setting `view.scene` does. A refresh that starts tiles over, as vector tiles do or time tiles whose manifest names a new base, keeps what they drew the same way.
- Changed: a view takes a refresh of time tiles in one change, once every span it fetched again has landed, rather than one change per span.
- Fixed: a plot drew its grid lines and axes about 400 ms after its traces on its first draw, since they waited for the text shaders. They now draw with the marks, and the tick labels follow once text can draw.
- Changed: hovering a line tracing a sampled field probes only the segments within the pick radius and the line's width of the pointer along the axis, not every point of every row.
