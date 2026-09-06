---
'@latkit/gpu': minor
---

Add `devices`, the realm-wide `DevicePool` every controller leases from unless given another: one device per page, requested by the first `acquire` and destroyed with the last release. `Presentation.observe` relies on `device-pixel-content-box` where the browser supports it.
