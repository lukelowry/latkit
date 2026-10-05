# Network example

Network topology, geographic projections, picking, and a palette catalog at `/colors.html`.

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

Open http://127.0.0.1:5188. The dev command builds dependencies first.

```sh
pnpm --filter @latkit/network-example build
```

Run `pnpm --filter @latkit/network test:browser` for rendering checks.

[Package usage](../../packages/network/README.md)

The coupled monitor/network demo is at `/coupled.html`. Both views share an application-owned
`Data` value; `signal` controls network color and height and the monitor traces. Scrub the shared
slider or press Play. Choose 16 representative traces or all 400 nodes. Playback follows
`requestAnimationFrame`; the frame-event counters report submitted frames and each view's actual
drawn coordinate, so differences remain visible. This is a local-history rendering demo, not a
transport or streaming-ingestion benchmark.

The soft-body demo is at `/bunny.html`: the Stanford bunny's 1,839 vertices as springs, a volume
pressure, and shape matching, simulated in the page. Each drawn frame appends its x, y, z, speed,
and strain to one `Data` value, which the network draws and the monitor traces; drag the bunny to
pull it, click to poke, or scrub to replay. The mesh is from the
[Stanford 3D Scanning Repository](https://graphics.stanford.edu/data/3Dscanrep/).

The BlackoutUSA map panel is at `/blackout.html`: Texas's substations as gauges of their output, a
wedge in a plant's ring and a bar in a load's, and branches colored by loading, dashed once out,
drawn apart when parallel, and carrying comets along their flow. A stand-in simulation ticks twice
a second; each tick eases in, and trips pulse.
