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
