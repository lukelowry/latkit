---
'latkit': patch
---

A view is complete as soon as everything it draws is ready, so `done()`, `complete`, and pictures come sooner on a cold page.

- Changed: `complete`, `done()`, and `waiting`'s `compiling` wait only for the pipelines frames draw with: those of the marks and any text, transitions while rows ease, the glow while a row is lit, and layers where depth varies. The pipelines that answer the pointer, picks, and queries no longer count, so on a cold page the first hover or pick can answer a moment after `done()`.
- Changed: a change that arrives before the transition pipelines have compiled applies at once, as with motion off, instead of compiling them in the frame that needs them.
- Changed: `gpu.step(now)` returns a promise that resolves once the GPU has finished the frame and its readbacks. `gpu.done()` still also waits for every requested pipeline.
- Removed: compiling ahead the pipelines nearly every scene uses when the first view opens. A GPU compiles only what its views ask for.
