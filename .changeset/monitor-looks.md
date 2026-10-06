---
'@latkit/monitor': minor
'@latkit/gpu': minor
---

A monitor's history holds what traces colored by a field read, not their colors: a new domain or colormap, or an animated shade, recolors it without drawing a line again.

Added

- monitor: `stats().segments`, the line segments drawn into history.
- gpu: `kit.sameReads`, whether two options differ only in how their color channels look.

Changed

- monitor: history keeps a layer per look. Traces of fixed colors share one layer of colors, as before; traces colored by a field share a layer of values for each look, which the monitor colors as it composes.
- monitor: an appending source keeps drawn history even when the same `set` changes traces. A trace that reads differently draws its layer again, and nothing else.
- monitor: history costs 8 bytes a pixel for each look of traces colored by a field, against 4 for all traces of fixed colors.
- gpu: `set()` compares typed arrays by what they hold, so equal rows keep what a view built.
