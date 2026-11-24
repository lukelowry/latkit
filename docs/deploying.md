# Deploy latkit

Install `latkit` from npm for browser or Node use. Install `latkit-cli` for the command line.

| Capability                          | Browser                        | Node                             | Native CLI                   |
| ----------------------------------- | ------------------------------ | -------------------------------- | ---------------------------- |
| Scenes, expressions, patch builders | `latkit`, no WebAssembly       | `latkit`, no WebAssembly         | JSON inputs                  |
| Data and queries                    | WASM, no GPU required          | WASM with a compiled module      | Available without a GPU      |
| Rendering                           | WebGL2 enabled in the browser  | Use the CLI for native rendering | Vulkan, Metal, DX12          |
| File/URL slices                     | Browser fetch and CORS         | Supply data directly             | Local paths and `file:` URLs |
| H.264 MP4                           | WebCodecs Constrained Baseline | Use the CLI                      | Windows Media Foundation     |

Serve WASM with `Content-Type: application/wasm`. Serve the JavaScript, WASM, and worker from the
same package version. Rendering requires an enabled WebGL2 context. WebCodecs video export requires
HTTPS or localhost.

## Assets and workers

- `latkit/wasm` renders scenes and includes the shaders for WebGL2.
- `latkit/jobs` handles layouts, edge lanes, triangulation, tile pyramids, and decoding
  vector tiles and GeoJSON. It loads on the first job.
- `latkit/wgsl` loads when a view first draws a [custom shader](scenes.md#custom-shaders).
- `latkit/worker` runs jobs in a classic web worker.

By default, `load()` finds the assets beside the installed modules. With Vite or another
bundler that supports URL imports, pass their URLs explicitly:

```ts
import { load } from 'latkit';
import wasmUrl from 'latkit/wasm?url';
import jobsUrl from 'latkit/jobs?url';
import wgslUrl from 'latkit/wgsl?url';
import workerUrl from 'latkit/worker?url';

await load({ wasm: wasmUrl, jobs: jobsUrl, wgsl: wgslUrl, worker: workerUrl });
```

If you supply a `wasm` URL, also supply `jobs` and, where workers are available, `worker`.
Missing assets cause an `invalid` error. Workers start on demand and stop after 30 idle
seconds. Without workers, jobs run on the calling thread.

A worker hosted on another origin is fetched and started from a Blob URL. Your Content
Security Policy must allow the asset and data origins in `connect-src`, package modules and
WebAssembly compilation in `script-src` (typically `'wasm-unsafe-eval'`), and the worker URL
in `worker-src`. Include `blob:` there for cross-origin workers.

To test without a GPU in Chrome or Electron, use
`--use-angle=swiftshader --enable-unsafe-swiftshader`. Call `gpu.lose()` to test device loss.

## Server-side builders and data

```ts
import { Patch, field } from 'latkit';

const bytes = new Patch().replace('T', [1], { value: [42] }).toBytes();
const expression = field('value').gt(0).toJSON();
```

Patches and expressions need no WebAssembly. To use datasets and queries in Node, compile the
package's WASM bytes into a `WebAssembly.Module` and pass it to `load({ wasm })`. To read GeoJSON
there, pass the jobs module the same way, as `jobs`. To render in a
worker, pass an `OffscreenCanvas` to `View.create`.
