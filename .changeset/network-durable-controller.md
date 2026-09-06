---
'@latkit/network': minor
---

One durable controller. `createNetwork(options)` is synchronous and takes neither a device nor a canvas; `attach(canvas)` leases a device and paints every retained state, `detach()` keeps it, and a lost device is replaced inside the controller.

- Added: `attach`, `detach`, `attached`, the `attached` event, `recovering` on `deviceLost`, `load(topology, { fit })`, and the live `keyboard`, `motion`, and `wheel` options.
- Changed: the `zoom` event is `fit`; `contextmenu` carries `{ event, keyboard, clientX, clientY, items }` with the hits already resolved; loading the topology already loaded is a no-op; borders draw only over a geographic topology; every channel slot is allocated at load.
- Removed: the device and canvas arguments to `createNetwork`, and the `Topology`, `Item`, and `Domain` re-exports. Import them, and `validateTopology`, from `@latkit/model`.
