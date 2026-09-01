# @latkit/network example

A Vite example for the published shape of [`@latkit/network`](../../packages/network).
It renders synthetic network topologies with WebGPU and exercises projections,
programmatic camera rotation and pose control, channels, colormaps, layer
visibility, lighting, and picking. The camera animation is off by default; use
**auto rotate** to start it - on the globe it spins the earth about its axis,
elsewhere it orbits the tilt camera - then click again or interact with the
canvas to stop it.

## Run

Requires a browser with WebGPU support.

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

The dev script builds `@latkit/gpu` and `@latkit/network` first, then starts Vite at
http://127.0.0.1:5188.

## Build

```sh
pnpm --filter @latkit/network-example build
```

The example depends on `@latkit/gpu` and `@latkit/network` through workspace
package links, so it consumes the same `dist` entrypoints a downstream app would use.
