# Network example

Pages that draw networks with `@latkit/network`.

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

Open http://127.0.0.1:5188. The dev command builds the packages first.

- `/`: topologies, geographic projections, and picking.
- `/colors.html`: the palette catalog in a CPU image, a CSS legend, and a WebGPU shader.
- `/coupled.html`: a monitor and a network that share one `Data` and one playhead.
- `/bunny.html`: a soft-body Stanford bunny simulated in the page, drawn by a network and traced
  by a monitor. Drag to pull it, click to poke it, or scrub to replay. The mesh is from the
  [Stanford 3D Scanning Repository](https://graphics.stanford.edu/data/3Dscanrep/).
- `/blackout.html`: the BlackoutUSA map panel. Texas substations draw as gauges of their output,
  and branches color by loading and carry comets along their flow.
