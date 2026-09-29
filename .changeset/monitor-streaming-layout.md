---
'@latkit/monitor': patch
---

Size the value-axis gutter from its visible labels before preparing live or exported plots, growing it only while a series streams and measuring it afresh with each load. Stretch a live series' time extent geometrically, so its history is laid out again O(log n) times rather than with every append. Cache the layout during playback and avoid redundant per-sample normalization when value and color domains match.
