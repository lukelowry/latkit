---
'@latkit/monitor': minor
'@latkit/gpu': minor
---

A monitor draws history only when lines move: a new domain or colormap, or an animated shade, recolors traces colored by a field without drawing a line again, and fitted values grow with headroom, so a live run's new extremes draw history again a few times rather than at each.

Added

- monitor: `stats().segments`, the line segments drawn into history.
- gpu: `kit.sameReads`, whether two options differ only in how their color channels look.

Changed

- monitor: history keeps a layer per look, holding only what composition cannot recover. Traces of fixed colors share one layer of colors, as before. Traces colored by what they plot keep coverage alone, at 1 byte a pixel, as the value of a line is where it lies. Traces colored by another field keep their color values, at 8 bytes a pixel. An image keeps up to four looks apart within a quarter of `historyBytes`; later looks bake into the color layer, as every look did before.
- monitor: `camera.fit` fits each window tightly, then grows the values by half the data's span past each side new data overflows.
- monitor: an appending source keeps drawn history even when the same `set` changes traces. A trace that reads differently draws its layer again, and nothing else.
- gpu: `set()` compares typed arrays by what they hold, so equal rows keep what a view built.
