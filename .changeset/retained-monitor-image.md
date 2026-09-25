---
'@latkit/gpu': minor
'@latkit/model': minor
'@latkit/monitor': minor
'@latkit/network': minor
'@latkit/diagram': minor
'@latkit/remote': patch
---

Keep the monitor's image on screen through repaints, and make NaN mean no value in every channel.

- Added: `Part` in `@latkit/model`, beside `Item`.
- Changed: `@latkit/monitor` keeps its last complete image on screen, rescaled into the current time and value ranges, while a resize or a new mapping repaints behind it. The repaint starts once the canvas size settles, and `valueRange` reports at once.
- Changed: `@latkit/monitor`'s automatic value range keeps a tenth of the recorded span to spare on each side and only grows until another series or signal loads, across detach and device loss.
- Changed: `@latkit/monitor` emits `hover` once per sample under the pointer, and `rendered` once no newer update waits.
- Changed: in `@latkit/network` and `@latkit/diagram`, an item whose color, height, size, status, flow, or dash value is NaN draws and picks as if the channel were unbound. Diagram visibility channels show only values above zero, as the network's do.
- Changed: `setChannel` in both renderers takes a `Float32Array` or a `Float64Array`, stores float32, and throws a `TypeError` for anything else. Clearing an unbound channel, or setting the borders already set, schedules no frame.
- Changed: `@latkit/network` advances `orbit` from its frame loop, so `pause()` and a hidden page hold it.
- Changed: `@latkit/diagram` redraws its glyphs when a web font finishes loading.
- Changed: `createSeries` reads yield to the event loop without the 4 ms timer clamp.
- Removed: `Part` from `@latkit/diagram`; import it from `@latkit/model`.
- Removed: the `quantize` option of `createFrameLoop`. Every loop quantizes while a resize is in flight, and `settled` means the size has held.
- Fixed: `@latkit/remote` ends an aborted run with a `cancelled` update, as `Runner` promises.
