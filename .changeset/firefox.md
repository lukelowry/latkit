---
'latkit': patch
---

Pages read GPU results back in Firefox without stalling it.

- Fixed: buffers that results are read back from are made for reading, which Firefox reads without stalling the GPU.
- Fixed: waiting on the GPU asks the browser to flush its commands, which Firefox needs before it promises to finish them.
