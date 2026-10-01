# Getting started

Use a WebGPU-capable browser and an ESM bundler such as Vite.

```sh
npm install @latkit/model @latkit/gpu @latkit/network
```

For plots, install `@latkit/monitor`; for export, add `@latkit/video`.
Import from package roots.

## Run an example

Clone the repository, then use Node.js 24 and pnpm 10.30:

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

| Example | Command filter            | URL                   |
| ------- | ------------------------- | --------------------- |
| Network | `@latkit/network-example` | http://127.0.0.1:5188 |
| Monitor | `@latkit/monitor-example` | http://127.0.0.1:5190 |
| Video   | `@latkit/video-example`   | http://127.0.0.1:5194 |

Each dev command builds its dependencies first. Network's `/colors.html` previews palettes.

## Connect your data

Renderers read a `Queryable` supplied by your application or
[`@latkit/connect`](ports-and-protocols.md). Latkit defines the data contract;
it does not provide a general-purpose model database.

Create one GPU owner, create a renderer over your source, and display it with
`createCanvasView`. Give the canvas an explicit CSS size.

Continue with [network usage](network-quickstart.md) or [monitor usage](monitor-quickstart.md).
