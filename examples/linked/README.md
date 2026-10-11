# Linked views example

A network and a monitor drawing one `Data` value at one playhead.

```sh
pnpm install
pnpm --filter @latkit/linked-example dev
```

Open http://127.0.0.1:5198. The dev command builds the packages first.

- `/`: signals over a lattice, colored and raised in the network and traced in the monitor.
- `/bunny.html`: a soft-body Stanford bunny simulated in the page, drawn by a network and traced
  by a monitor. Drag to pull it, click to poke it, or scrub to replay. The mesh is from the
  [Stanford 3D Scanning Repository](https://graphics.stanford.edu/data/3Dscanrep/).
