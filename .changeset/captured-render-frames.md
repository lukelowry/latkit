---
'@latkit/gpu': minor
'@latkit/network': patch
'@latkit/monitor': patch
'@latkit/diagram': patch
'@latkit/video': patch
---

Replace renderer prepare/encode hooks with captured and prepared frame contracts. Ordinary
invalidation schedules the latest state without cancelling valid work; canvas playback coalesces
requests without adding an extra animation-frame wait. Compositions capture every child before
preparation, and images and video share submission and discard behavior.

Monitor append progress survives cancelled frames and tracks independently sampled fields.
Bounded camera-independent tiles reuse geometry and exact bounds for domain changes, with local
refinement at summary boundaries and local rereads on cache misses. Models and transport remain
free of observation retention and replay.
