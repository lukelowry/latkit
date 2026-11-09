---
'latkit': patch
---

Views in WebKit show their first complete frame in about a second instead of nine, and `gpu.done()` resolves once the GPU finishes, even on a page that reads back every frame.

- Fixed: each frame is fenced before the page copies the canvas, and a wait for the GPU with no work given to it since joins the newest fence. WebKit reported a fence made after a canvas copy as unsignaled for about 8 seconds after the GPU finished, which held back pipelines, readbacks, and `gpu.done()`.
- Fixed: once a fence signals, the waits on every fence before it end too, so a fence a browser reports late no longer holds back the waits made after it.
- Fixed: `gpu.done()` and `gpu.step()` wait for the work submitted before the call and the readbacks it copies, not for a moment with no readback in flight. On a page that reads back every frame, such as a plot fitting its range to streaming data, `gpu.done()` timed out in WebKit.
- Changed: readbacks submitted together share one fence.
