---
'@latkit/model': minor
'@latkit/connect': minor
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/video': minor
'@latkit/diagram': minor
---

Replace the previous model and rendering APIs with native Queryable data, explicit
retained acquisitions, shared GPU rendering, and worker/socket connections.

Network and monitor use the shared GPU and canvas-view lifecycle. Video exports
renderers directly, including composed views. Colors now come from @latkit/gpu.
Rewrite usage guides and package READMEs for these APIs.

This is a breaking pre-1.0 release. Migrate consumers together; the retired port,
colormaps, document-session, and scene-snapshot APIs have no compatibility exports.
Diagram now provides a complete runtime over the shared GPU lifecycle, with native
fields, headless arrangement, measured labels, routing, groups, editing proposals,
and indexed picking. GPU exposes a bounded, device-independent native read session
for headless consumers.
