---
'latkit': minor
---

Frames place each segment of a path once, a hover draws only the rows it lights, and thin lines stay solid.

- Changed: each frame works out where every segment of the edges and lines it draws lies on screen once, before drawing, and the opaque, rows, comets, and lit draws of a mark all read that, rather than each corner of each draw working it out again. A trace's segment and a point cost less to place than to store, so their draws place them. On an integrated GPU, a plot of 2,000 traces takes 39 ms of GPU time a frame rather than 50 ms.
- Changed: in a browser, a render pass reuses the WebGL framebuffer that holds its targets rather than making one.
- Changed: hovering a row no longer draws every mark again. The frame starts from the kept image of the marks, and only the hovered row and the rows it lights draw over it. On a grid of 900,000 lines and buses on an integrated GPU, a hover takes one frame of about 3 ms of GPU time, rather than frames of 36 ms and 18 ms.
- Changed: a hovered marker grows under its label rather than pushing the label outward, so a hover lays out no labels.
- Changed: on a globe, a frame that starts from the kept image of the marks draws only the globe's depth under it, not the whole backdrop again.
- Changed: in a browser, latkit checks for WebGL errors once the GPU has caught up with the work given it, so the check answers at once rather than holding the page behind the next frame. While frames keep the GPU busy, it waits at most a second. Waits on the GPU poll every task for their first 3 ms, then back off to every 4 ms, rather than polling every task for as long as they wait.
- Changed: appending frames to a sampled field folds each frame into the levels of detail as it goes, so sealing a bucket no longer reads its frames again. On a 165,000-row field, appends no longer take 20 to 35 ms on every 8th and 64th frame.
- Fixed: hovering or selecting a row threw away the kept image of the marks, a texture the size of the canvas, and made it again the frame after. Its texture now stays through such frames, and goes after 120 frames in a row without it.
- Fixed: lines thinner than a screen pixel, such as 1 px traces at a browser zoom of 50%, looked dotted along diagonals. They now draw a pixel wide, as bright as their width's share of it.
