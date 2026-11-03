---
'latkit': patch
---

A call that times out cancels the work it gave up on, and destroying an object always frees its memory.

- Fixed: a call given no signal times out once, after 30 seconds across all its steps, and cancels the fetch or stream read it gave up on. Before, each step waited 30 seconds of its own, and a stalled read stayed running with its stream locked.
- Fixed: `destroy()` frees an object's memory even when its own cleanup throws.
- Changed: `Data.read` waits for latkit to load within its signal too, and reads a `Response` or `Blob` as a stream, so its signal cancels the read.
