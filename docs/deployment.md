# Deployment and platforms

Install `latkit` from npm for JavaScript and `latkit-cli` from Cargo for the `latkit` command.
The Rust library is the `latkit` crate. The WASM binding crate is an implementation detail.

| Capability                          | Browser                        | Node                             | Native CLI                   |
| ----------------------------------- | ------------------------------ | -------------------------------- | ---------------------------- |
| Scenes, expressions, patch builders | `latkit/core` or `latkit`      | `latkit/core`, no DOM types      | JSON inputs                  |
| Data and queries                    | WASM, no GPU required          | WASM with a compiled module      | Available without a GPU      |
| Rendering                           | WebGPU in a secure context     | Use the CLI for native rendering | Vulkan, Metal, DX12          |
| File/URL slices                     | Browser fetch and CORS         | Supply data directly             | Local paths and `file:` URLs |
| H.264 MP4                           | WebCodecs Constrained Baseline | Use the CLI                      | Windows Media Foundation     |

Serve WASM with `Content-Type: application/wasm`. WebGPU requires HTTPS or localhost and a
supported device. Keep the JavaScript, WASM, and worker from the same package version together.
Images and raw frame output are available where native MP4 encoding is unavailable.

## Assets and workers

Default loading resolves assets beside the installed modules. With Vite or another bundler
supporting URL imports, explicit assets also work under nested deployment paths:

```ts
import { loadLatkit } from 'latkit';
import wasmUrl from 'latkit/wasm?url';
import workerUrl from 'latkit/worker?url';

const kit = await loadLatkit({
  wasm: wasmUrl,
  createWorker: () => new Worker(workerUrl),
});
```

`latkit/worker` is a standalone classic worker. A custom factory may use a Blob URL; retain the
URL while the factory can be called and revoke it on application teardown. Workers are created
on demand and retire when idle. Where workers are unavailable, jobs run on the calling thread.

Your Content Security Policy must allow the WASM asset and data origins in `connect-src`,
WebAssembly compilation (typically `'wasm-unsafe-eval'` in `script-src`), and the worker URL in
`worker-src`. Add `blob:` only when using Blob workers. Cross-origin resources need appropriate
CORS headers. These requirements are deployment choices; latkit does not change your policy.

## Server-side builders and data

```ts
import { Patch, field } from 'latkit/core';

const bytes = new Patch().replace('T', [1], { value: [42] }).toBytes();
const expression = field('value').gt(0).toJSON();
```

For Node data/query operations, load the package's matching WASM bytes as a `WebAssembly.Module`
and pass it to `loadLatkit({ wasm })`. This runtime entry point exposes browser rendering types;
server projects that only write patches should use `latkit/core`. For worker rendering, provide
an `OffscreenCanvas` and drive `gpu.step(now)` if the environment has no animation-frame loop.

See [resource lifetimes](views.md#stats-and-memory) and [video cleanup](pictures.md#video).
