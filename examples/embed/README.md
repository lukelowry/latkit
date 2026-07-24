# @latkit/embed contract example

This Vite consumer demonstrates the complete public `latkit-network` contract without an
example-local renderer controller or compatibility layer.

The main embed uses only public markup and built-in controls. It includes:

- a geographic topology that supports flat, tilt, and globe projections;
- labels plus three vertex fields and two edge fields;
- initial bindings for all five canonical Network channels;
- independent channel domains and a vertex-height output range;
- caption, projection, navigation, colormap, channel, and legend controls;
- representative renderer, focus, lighting, color, and border options;
- packaged Natural Earth borders and useful non-WebGPU fallback content;
- keyboard-operable canvas interaction and focused `controls="none"` and partial-control examples.

`src/main.ts` performs registration and reports readiness only. All live view configuration belongs
to `latkit-network` markup and methods.

## Run

Requires a browser with WebGPU support.

```sh
pnpm install
pnpm --filter @latkit/embed-example dev
```

The example is served at <http://127.0.0.1:5192/>.

## Build

```sh
pnpm --filter @latkit/embed-example build
```
