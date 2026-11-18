---
'latkit': patch
---

Fewer stalls on the browser's GPU process, plots that fit their traces on the CPU, and time tiles that draw their last frames at every zoom.

- Fixed: with time tiles, a plot zoomed out far enough to draw from a coarse level left out the frames past that level's last whole bucket: up to 511 frames where it draws buckets of 512. They are now fetched from the finer levels that hold them and drawn.
- Changed: with WebGL, latkit reads back from the GPU and reads its errors only while the GPU has finished everything issued, which happens between frames. Such a read waits for the browser's GPU process to finish everything issued before it, so a read made after the next frame was issued waited out that frame's GPU work: several milliseconds a frame while zooming or hovering. Where the GPU never finishes between frames, a readback waits at most 50 ms, and errors outside a scope at most a second.
- Changed: a plot without a value range fits it to its traces from the samples it holds on the CPU, as the traces change or the window moves. It no longer measures them on the GPU and reads the result back a frame later. A trace whose rows' visibility comes from a field is still measured on the GPU.
- Changed: hover and edge labels no longer read the points on either side of each segment, which only strokes need to join their segments.
