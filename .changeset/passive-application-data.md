---
'@latkit/model': minor
'@latkit/connect': minor
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/monitor': minor
'@latkit/diagram': minor
'@latkit/video': minor
---

Breaking change: remove model retention and historical reads. Models publish one-pass passive
transactions, commands are a separate optional capability, and applications own immutable
columnar Data. Views consume Data directly and accept updates with set({ source: nextData }).
Local read computes rows, samples, aggregates, and envelopes without contacting a producer.
Connect protocol 3 removes queryable roots, retained reference trees, and remote exports;
upgrade both peers together. Delivered values survive unsubscribe and disconnect. Shared
unchanged pages preserve local read caching and GPU uploads.
