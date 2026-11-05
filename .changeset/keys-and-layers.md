---
'latkit': patch
---

Flat views open about 0.4 s sooner, and stepping through rows with the keys costs the same however many rows are in view.

- Fixed: a view whose depth doesn't vary (straight down at a plane or flat map, with no rows raised) no longer compiles or waits for the opaque draws and the height sorting it never uses, so `complete`, `done()`, and pictures come sooner. A view asks for them once its camera tilts, the globe shows, or rows stand at heights, and until they are ready it draws its marks in order.
- Fixed: Tab and the arrow keys find the next row on the GPU and read back only that row. Before, the first step read back and decoded every row in view, an 80 ms frame on a view of a few thousand rows.
- Changed: an arrow that finds no row its way pans the camera a frame or two later, once the GPU has looked.
