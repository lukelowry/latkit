# @latkit/monitor example

A Vite example for the published shape of [`@latkit/monitor`](../../packages/monitor).
It renders synthetic streaming signals with WebGPU and exercises signal switching, colormaps, range control, picking, focus, pause, and resume.

## Run

Requires a browser with WebGPU support.

```sh
pnpm install
pnpm --filter @latkit/monitor-example dev
```

The dev script builds `@latkit/colormaps`, `@latkit/gpu`, and `@latkit/monitor`, then starts Vite at `http://127.0.0.1:5190`.

## Build

```sh
pnpm --filter @latkit/monitor-example build
```

The example depends on `@latkit/gpu` and `@latkit/monitor` through workspace package links, so it consumes the same `dist` entrypoints a downstream app would use.
