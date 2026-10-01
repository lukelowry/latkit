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
