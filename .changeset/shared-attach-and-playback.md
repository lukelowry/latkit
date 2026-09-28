---
'@latkit/colormaps': minor
'@latkit/diagram': minor
'@latkit/embed': minor
'@latkit/gpu': minor
'@latkit/model': minor
'@latkit/monitor': minor
'@latkit/network': minor
'@latkit/remote': minor
---

Share one attach lifecycle across every controller, let network channels follow recorded series, draw long monitor histories at canvas resolution, and drop what no consumer uses.

- Added: `createAttachment` in `@latkit/gpu`, the attach lifecycle every controller now shares: supersession, joining a repeat attach, and recovery from device loss.
- Added: a `canvas` getter on `Network`, `Diagram`, and `Monitor`: the canvas bound or binding.
- Added: `setChannel` on `Network` and `Diagram` takes `{ series, signal }` to follow one signal of a `Series`, and `seek(time)` shows every such channel at a playhead. The frames around it stay resident on the GPU, shared by the channels following one signal, and the next ones load as it plays or the series appends, so a seek within them rewrites one word per channel. A null domain follows the signal's recorded range, and both emit `error` with the channel when a series read fails. Every channel can follow a series but `vertexPosition`, `blockPosition`, `blockVisible`, and `netVisible`.
- Added: `createPlayback` in `@latkit/model`, the series playback both renderers share.
- Added: `parseColor` in `@latkit/colormaps`, reading hex, `rgb()`, `oklab()`, `oklch()`, `color(srgb)`, and `transparent`; with an element it resolves any color the element computes, custom properties included.
- Added: a `label` on every `OPTIONS` entry of the network, the diagram, and the monitor, and `min` and `max` on bounded numbers.
- Added: `Runner<Command>`, and `serveSource<Command>(port, served, { command })`, which requires the guard of a structured command where the peer sends it. `Uint8Array` stays the default.
- Changed: `attach` resolves `true` once bound, or `false` at once when a newer attach or a detach takes over, instead of rejecting with `AbortError`. Attaching the canvas already bound, binding, or recovering from a lost device joins that attach, and `detach(canvas)` detaches only while that canvas is the current one.
- Changed: `@latkit/monitor` draws a history repaint over more than two frames per device pixel as each pixel column's extremes, in the order they occurred, and paces repaints by a few milliseconds of work per frame. Appends, the selected trace, and readings stay exact.
- Changed: `PROJECTIONS` is a frozen record of `{ label }` keyed by mode, like `CHANNELS`; iterate `Object.keys(PROJECTIONS)`.
- Changed: `nightFloor` and `surfaceNightFloor` reject values outside `[0, 1]`, and `terminatorWidth`, `hoverAlpha`, `selectedAlpha`, and the monitor's `unselectedAlpha` values above 1.
- Changed: `@latkit/embed` color attributes take four decimals or any color `parseColor` reads, resolved on the element.
- Removed: `frameAt` from `@latkit/model`.
- Removed: `serveGrid`, `connectGrid`, `GridHeader`, `GridServer`, `reopen`, and `RemoteSource` from `@latkit/remote`; `connectSource` resolves a `Remote<Served>`.
- Removed: the `Interaction` and `Insets` types from `@latkit/network`, and `Interaction` from `@latkit/diagram`; name `Options['interaction']` and `Options['fitPaddingPx']` instead.
