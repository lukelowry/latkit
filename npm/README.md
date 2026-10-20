# latkit

Columnar data drawn as vertices, edges, lines, and areas with WebGPU.

```ts
import { loadLatkit, Patch, field, type Scene } from 'latkit';

const { Data, Gpu } = await loadLatkit();
const data = new Data('grid').apply(
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
const view = gpu.view(scene);
gpu.canvas(document.querySelector('canvas')!).show([view]);
view.setData(data);
view.fit();
```

- **Plain data needs no WebAssembly.** Scenes, expressions, and patches are built without loading
  anything, so a worker or a Node server writes patches as well as a page. `loadLatkit()` loads the
  WebAssembly once per page; `Gpu.create()` requests a WebGPU device.
- **Data changes in place.** `data.apply(patch)` makes every change or none. `data.snapshot()` keeps a
  version in O(1), sharing its pages, as an undo history does. A view draws the version it was
  given until `setData` gives it another.
- **Patches are bytes.** A patch is a frame of latkit's byte format, written in TypeScript as it is
  built; servers in any language write the same frames. `Patch.stream(body)` yields them as they
  arrive, and `Data.read(bytes)` reads a dataset's bytes or GeoJSON.
- **Data reads back** without a GPU, through the expressions marks draw with:
  `data.query({ of, filter, sort, select, limit })`, `data.describe()`, `data.envelope(...)`.
- **Types come from the schema.** Scene, query, camera, and fit types (`inputs.ts`) and events,
  hits, and stats (`outputs.ts`) are written from latkit's JSON Schema; `latkit schema` prints it.
- **Errors** throw a `LatkitError`: a `code` (`invalid`, `unsupported`, `limit`, `io`, `device-lost`,
  `cancelled`, `timeout`) and, for invalid input, the `path` to the part.
- **Handles** (`Data`, `Gpu`, `View`, `Canvas`, `Image`) have idempotent `destroy()` and
  `Symbol.dispose`. Picks, locations, and layouts reject with `cancelled` when their view is
  destroyed, and with `timeout` when no frame draws it in time.

Workers start when a view first needs one, share the compiled module, and retire after 30 seconds
idle. For your own asset hosting, pass the matching `latkit/wasm` and `latkit/worker` exports; the
worker is a standalone script, fine as a Blob URL:

```ts
import wasmUrl from 'latkit/wasm?url';
import workerUrl from 'latkit/worker?url';

const kit = await loadLatkit({ wasm: wasmUrl, createWorker: () => new Worker(workerUrl) });
```

Serve WebAssembly as `application/wasm`, in a secure context for WebGPU.

From the repository: `cargo xtask wasm --dev` builds the package for development, and
`cargo xtask package` builds an optimized tarball under `target/npm`.
