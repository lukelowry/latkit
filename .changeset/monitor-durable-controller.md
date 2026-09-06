---
'@latkit/monitor': minor
---

One durable controller, as on `Network`. `createMonitor(options)` is synchronous and takes neither a device nor a canvas; `attach(canvas)` leases a device and paints the retained series, signal, frontier, selection, and options, `detach()` keeps them, and a lost device is replaced inside the controller.

- Added: `attach`, `detach`, `attached`, the `attached` event, `recovering` on `deviceLost`, the `OPTIONS` registry, and `validateOptions`.
- Changed: `setOptions` replaces `setColormap` and `setValueRange` (`valueRange: null` fits the committed extent); `select(element | null)` replaces `setFocus`; the `select` event replaces `pick`, and pointer-down selects the element it reports.
- Removed: the device and canvas arguments to `createMonitor`, and the `Series` and `Domain` re-exports. Import them from `@latkit/model`.
- Faster: the auto-fit range grows from newly committed frames only, switching signals no longer reallocates GPU storage, and the focus trace uploads incrementally.
