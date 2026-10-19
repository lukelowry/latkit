# Latkit

Columnar data drawn as vertices, edges, lines, and areas with WebGPU.

```ts
import { loadLatkit, type Scene } from 'latkit';

const { Data, Patch, Gpu } = await loadLatkit();
const gpu = await Gpu.create();
const empty = new Data('grid');
const data = empty.apply(new Patch().put('Bus', 2, { x: [0, 30], y: [0, 20] }));
empty.destroy();

const scene: Scene = {
  space: 'plane',
  marks: [{ vertices: { of: ['grid', 'Bus'], position: ['x', 'y'], radius: 6 } }],
};
const view = gpu.view(scene);
gpu.canvas(document.querySelector('canvas')!).show([view]); // or several views in { panels }
view.setData(data);
view.fit('all');

// When the application closes this visualization:
gpu.destroy(); // also destroys its canvases, views, and frame listeners
data.destroy();
```

Importing `latkit` only loads scene helpers and the loader. `loadLatkit()` initializes WASM;
`Gpu.create()` separately requests a WebGPU device. Concurrent loads share the same promise.
A failed load can be retried. Later calls can omit options to reuse the runtime; explicitly
conflicting options reject with an error whose `code` is `load`.

Data reads back without a GPU, through the same expressions marks draw with, and patches stream:

```ts
const hot = data.query({
  of: 'Branch',
  where: field('loading').gt(90),
  sort: [['loading', 'descending']],
  limit: 12,
});
// hot: { table, ids, fields: { loading: Float64Array, name: string[], ... } }, the forms Patch.put takes
const { tables, span } = data.describe();
const { least, greatest } = data.envelope('Bus', 'vm', span!, 600); // per row and span, from levels
for await (const patch of Patch.stream((await fetch('/feed')).body!))
  view.setData((data = data.apply(patch)));
```

Scene, query, camera, and fit types are written from the JSON Schema of what latkit reads
(`schema.json`; `latkit schema` prints it for other languages). Ids too large for a JavaScript number
read back as their decimal text, which names the same row.

`Data.apply()` returns a new immutable snapshot and consumes the patch. Destroy an old handle when
it is no longer needed; views and other snapshots keep their own references to its data. `Data`,
`Patch`, `Gpu`, and `View` support idempotent `destroy()` and `Symbol.dispose`. Other operations on
destroyed handles throw. A GPU can host multiple views; destroying it leaves other GPUs operational.
Pending picks and locations reject with `code: 'cancelled'` when their view is destroyed.

Workers start only when needed, share the compiled module, and each instantiate their own memory.
They retire after 30 seconds idle and restart on demand. Jobs time out after one minute. Destroying
a GPU does not interrupt another GPU's jobs or independent GeoJSON decoding.

For custom asset hosting, use the matching `latkit/wasm` and `latkit/worker` exports. The worker is a
standalone classic script, suitable for a Blob URL in a restricted webview. For example, with Vite:

```ts
import { loadLatkit } from 'latkit';
import wasmUrl from 'latkit/wasm?url';
import workerUrl from 'latkit/worker?url';

const kit = await loadLatkit({
  wasm: wasmUrl,
  createWorker: () => new Worker(workerUrl),
});
```

Serve WASM as `application/wasm` and serve the application in a secure context for WebGPU. No server
runtime is required; the npm package can be deployed as static assets. Scene helpers and types can
be imported during server-side rendering; call the loader and create views on the client.

From the repository, `cargo xtask wasm --dev` builds local development assets; `cargo xtask package`
builds an isolated optimized npm tarball under `target/npm`. Install workspace tools with
`pnpm install --frozen-lockfile` and use the `wasm-bindgen` CLI version in `Cargo.lock`. Binaryen,
TypeScript, and esbuild come from the workspace lockfile. `cargo xtask package-test` installs the
tarball into an isolated consumer, checks its types and loading/worker contracts, and runs it in
Chrome under a nested deployment path. Its size report and browser timings live in `target/npm`.
Browser timings record the tested machine and renderer; they are measurements, not portable speed
guarantees. Neither command publishes anything.
