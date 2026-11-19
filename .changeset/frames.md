---
'latkit': minor
---

Frames draw only the marks that change, and rows whose heights change every frame stay smooth.

- Changed: in a run of frames where only some marks change, as a shade reading the time or a layer of streaming rows does, or where only comets move, each frame starts from a kept image of the marks before the first that changed and draws only the rest. A lone such frame between changes draws whole.
- Changed: under `daylight`, the sun moves in steps of 4 seconds of the view's axis, too small to see, so a view playing through time keeps its kept image for a step rather than drawing every mark each frame.
- Changed: where heights change every frame, as a sampled field raising rows during playback, the sort that draws raised rows nearest last spreads over frames under a fixed budget, and frames draw in the last finished order meanwhile. A small table still sorts every frame.
