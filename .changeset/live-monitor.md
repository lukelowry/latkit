---
'latkit': patch
---

A live monitor no longer pauses for reads of GPU results or for memory, and takes in its frames faster.

- Changed: in a browser, a frame first takes the reads of GPU results whose work the GPU finished, and while a read waits and the GPU has not finished the frame shown last, canvases hold the next frame. A read then never waits behind a frame given the GPU after it. In a live monitor on an integrated GPU, reads take at most 3 ms rather than up to 21 ms.
- Changed: appending frames to a sampled field reads `f32` values as they are stored, and converts other values once per append rather than one at a time. Appends take about a third less time.
- Fixed: a recording whose memory keeps growing paused for 100 to 250 ms whenever its row blocks opened new pages together, as each page grew the WebAssembly memory on its own. Appends make room for those pages at once, and once the memory holds 64 MB or more, latkit keeps an eighth of it free ahead.
