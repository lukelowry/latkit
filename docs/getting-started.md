# Getting started

Use a WebGPU-capable browser and an ESM bundler such as Vite.

```sh
npm install @latkit/model @latkit/gpu @latkit/network
```

Add `@latkit/monitor`, `@latkit/diagram`, or `@latkit/video` as needed.

```ts
import { createGpu } from '@latkit/gpu';
import { createNetwork } from '@latkit/network';

const gpu = await createGpu();
const network = createNetwork(gpu, {
  canvas,
  source,
  vertices: { Bus: { color: 'load', labels: 'name' } },
  edges: { Line: { ends: ['from', 'to'] } },
});
```

`canvas` needs a CSS size. `source` is a `Queryable`: your own model, or one served over
[`@latkit/connect`](ports-and-protocols.md). [Views](views.md) covers what every view shares.

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
| Diagram | `@latkit/diagram-example` | http://127.0.0.1:5192 |
| Video   | `@latkit/video-example`   | http://127.0.0.1:5194 |

Each dev command builds its dependencies first. Network's `/colors.html` previews palettes.
