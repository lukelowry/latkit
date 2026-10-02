---
'@latkit/monitor': minor
'@latkit/model': minor
'@latkit/connect': minor
'@latkit/gpu': minor
'@latkit/network': minor
---

Monitors draw streamed frames reliably: each image keeps what it has drawn and draws only what it is missing. Network picking stays fast at a million vertices.

Added

- `Progress.domain`: the coordinates a run covers, carried by connect.
- `sampleFrames(pages, window)` in model: the frames a sample window covers.

Changed

- Monitor history draws, each frame, what an image is missing, continuing from the last frame drawn. Arrivals reach the shown image first; a new window or value range redraws behind it while the shown image stretches to the camera's axes. Fixed windows at epoch coordinates, and monitors created before any samples, now stream.
- Monitor fitted values come from per-page extents, so appends never read history again.
- Monitor limits are `{ rows, segmentsPerFrame, historyBytes, pickingBytes }`; `segmentsPerFrame` bounds the lines drawn per frame.
- Network `pick` and hover use a compact hit-test index, built in the background within `limits.pickingBytes`: a million vertices and two million edges fit the default, and pick takes milliseconds instead of seconds. `stats().pickingBytes` counts the index as it builds.
- A hover budget miss suspends automatic hover until the scene moves or the view can search faster, as when its index is built.
- gpu field pages bind four value buffers, which needs five storage buffers per shader stage; pages keep every frame of their rows; buffers grow with use; cache eviction takes constant time in model and gpu.

Removed

- Monitor `camera.follow`, `detail`, `autoDomain`, `limits.frameMs`, `limits.observationsPerFrame`, `stats().pendingBytes`, and pointer pan and zoom.
