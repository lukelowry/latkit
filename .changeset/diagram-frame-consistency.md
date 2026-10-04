---
'@latkit/diagram': patch
'@latkit/gpu': minor
---

Complete diagram integration with shared text layout, routing, and spatial indexing. Keep sampled
visual values separate from structural geometry, use frame uniforms for default colors and edge
width, and keep picking aligned with the submitted frame. Preserve connect and reconnect gestures
and reacquire GPU resources through each frame after trimming.

Reduce temporary allocations in routing, spatial queries, and geometry encoding. Expose the shared
text layout operation on `Gpu` and avoid composing an abort signal when no caller signal is supplied.
