---
'latkit': patch
---

GPU memory is freed when latkit is done with it, pipelines compile once in every browser, and every view reports each device error.

- Added: `destroyed` in `gpu.work`, the bytes of GPU memory latkit freed.
- Changed: GPU memory that latkit replaces, or that a closed view, canvas, or finished picture leaves behind, is freed by the next frame, not when the browser collects it.
- Changed: the budget defaults to half the device's largest storage buffer, at most 1 GiB.
- Changed: a large load grows the page pool once, instead of doubling it page by page.
- Changed: a device without the memory to grow the page pool lowers the budget to what it gave. In a browser, latkit gives up that device, and the views move to a new one within the lowered budget.
- Changed: each pipeline compiled in the background is the one drawn with, in every browser, instead of being compiled again. Every pipeline's label names it exactly.
- Changed: every view reports each error the device raises once, whichever view draws first, even while nothing draws. Failures of the jobs and fetches a view started reach that view alone.
- Changed: a custom marker whose WGSL does not compile is listed in `failures` as `marks[i].marker` and never draws, instead of an `error` event.
