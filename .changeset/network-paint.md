---
'@latkit/network': patch
---

A frame a host can await.

- Added: `paint()` schedules a frame and resolves once it is painted, after a pending shade and a deferred camera placement; every caller between two paints shares one promise. It rejects while detached, on detach, and with the cause of a pipeline failure for the active projection.
- Changed: a pipeline failure is forgotten on re-attach and when a later shade compiles, so `pipelineError` is not replayed to late subscribers after the renderer that reported it is gone.
