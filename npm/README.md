# latkit

Columnar data drawn as vertices, edges, lines, and areas with WebGPU.
[Documentation](https://latkit.readthedocs.io).

```ts
import { Data, Gpu, Patch, field, load, type Scene } from 'latkit';

await load();
const grid = new Data('grid').apply(
  new Patch().replace('Bus', [101, 102], { x: [0, 30], y: [0, 20], kv: [230, 115] }),
);

const scene: Scene = {
  space: 'plane',
  marks: [
    {
      vertices: {
        of: ['grid', 'Bus'],
        position: ['x', 'y'],
        radius: 6,
        color: field('kv').colormap('viridis'),
      },
    },
  ],
};
const gpu = await Gpu.create();
const view = gpu.view(scene, { sources: [grid] });
gpu.canvas(document.querySelector('canvas')!, { layout: [{ view }] });
view.fit();
```

- **Plain data needs no WebAssembly.** Scenes, expressions, and patches are built without loading
  anything, so a worker or a Node server writes patches as well as a page. `load()` loads the
  WebAssembly once per page; `Gpu.create()` requests a WebGPU device.
- **Views draw sources.** `view.sources` names the datasets a view draws: a `Data` at its latest
  version from the frame after each patch applies, a `Snapshot` as it is, or `Tiles` fetched in
  pieces as the camera and plot window ask.
- **Data changes in place.** `data.apply(patch)` makes every change or none. `data.snapshot()` keeps a
  version in O(1), sharing its pages, as an undo history does; `data.restore(snapshot)` brings it
  back.
- **Patches are bytes.** A patch is a frame of latkit's byte format, written in TypeScript as it is
  built; servers in any language write the same frames. `Patch.stream(body)` yields them as they
  arrive, and `Data.read(source)` reads a dataset's bytes, its JSON, or GeoJSON.
- **Data reads back** without a GPU, through the expressions marks draw with:
  `data.query({ of, filter, sort, select, limit })`, `data.describe()`, `data.envelope(...)`.
- **Types come from the schema.** Scene, query, camera, and fit types (`inputs.ts`) and events,
  hits, and stats (`outputs.ts`) are written from latkit's JSON Schema; `latkit schema` prints it.
- **Waits end at a signal.** Picks, locations, layouts, pictures, and encodings take `{ signal }`
  and give up after 30 seconds unless it says otherwise: with `timeout` when it timed out, with
  `cancelled` when it was aborted or the view went.
- **Errors** throw a `LatkitError`: a `code` (`invalid`, `unsupported`, `limit`, `io`, `device-lost`,
  `cancelled`, `timeout`, or `unloaded` before `load()`) and, for invalid input, the `path` to the
  part.
- **Handles** (`Data`, `Snapshot`, `Gpu`, `View`, `Canvas`, `Image`) have idempotent `destroy()` and
  `Symbol.dispose`.

Workers start when a view first needs one, share the compiled module, and retire after 30 seconds
idle. For your own asset hosting, pass the matching `latkit/wasm` and `latkit/worker` exports; the
worker is a standalone script, fine as a Blob URL:

```ts
import wasmUrl from 'latkit/wasm?url';
import workerUrl from 'latkit/worker?url';

await load({ wasm: wasmUrl, worker: () => new Worker(workerUrl) });
```

Serve WebAssembly as `application/wasm`, in a secure context for WebGPU.

From the repository: `cargo xtask wasm --dev` builds the package for development, and
`cargo xtask package` builds an optimized tarball under `target/npm`.

LATK v1 uses 64-bit frame indexes. Sample values use `f32` and axis coordinates use `f64`.
`Video.record()` cleans up on failure; manual recordings must finish or abort.
See [deployment and platform support](https://latkit.readthedocs.io/en/latest/deployment.html).
