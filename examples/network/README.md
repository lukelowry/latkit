# @latkit/network example

A standalone host for the native `@latkit/model`, `@latkit/gpu`, and `@latkit/network` APIs. Color values, palettes, legends, and GPU sampling all come from `@latkit/gpu`.

The power grid, small geographic grid, and 100,000-vertex grid generate native columns and binary connection endpoints directly. `ExampleSource` implements immutable `Queryable` acquisitions. There is no legacy topology or channel conversion. The host owns the source, GPU, canvas view, and input attachment; the renderer borrows them.

Controls cover flat/tilt/globe projections, orbit, fit, colormaps, height, geodesics, detailed borders, lighting, surface poles, visibility, and native-row picking. Automatic hover uses the renderer's bounded policy. The status shows submitted frame statistics.

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

Open http://127.0.0.1:5188. The script builds dependencies before starting Vite. `pnpm --filter @latkit/network-example build` checks types and produces the production bundle.

The detailed border toggle loads the same native Natural Earth fixture as the network package's headed demonstration; Vite includes the binary assets in the production build. To open that separate recording/channel and performance demonstration:

```sh
pnpm --filter @latkit/network test:browser
```

See [the network API](../../packages/network/README.md) for complete bindings and ownership details.

The palette picker includes every continuous catalog map and reversal. Open `/colors.html` for all 46 maps side by side in CPU, CSS, and WebGPU, with family filtering and dark/light backgrounds.
