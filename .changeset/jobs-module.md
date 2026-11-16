---
'latkit': minor
---

The module that draws is a tenth smaller: jobs run in a module of their own, the browser encodes the pictures it writes exactly, and flat maps keep areas as they are.

- Added: `latkit/jobs`, the WebAssembly that does the work views and datasets hand to workers: layouts, lanes, triangles, tile pyramids, decoding vector tiles and GeoJSON, and encoding pictures. A page loads it with its first job. `load({ jobs })` takes its URL or the compiled module.
- Added: in Rust, `Host::encode` encodes a picture as a file, and `host::read` reads a dataset with GeoJSON parsed in a job.
- Changed: `latkit/wasm` is 3.50 MB, 1.12 MB with brotli. It was 3.89 MB and 1.23 MB. Workers load the jobs module in place of a second copy of it.
- Changed: the assets come as a set. A page that gives `load` the URL of `wasm` gives it `jobs` and `worker` too, or `load` rejects with an `invalid` error. Before, a missing asset failed only when a view first needed it.
- Changed: every job runs in a worker. Before, a small one ran on the frame that asked for it, so a small scene now draws its triangles or layout a frame or two after its first frame. The lanes of up to 32,768 edges are still assigned on the frame.
- Changed: in Node, `Data.read` reads GeoJSON only after `load({ wasm, jobs })` with the jobs module compiled like the first.
- Changed: `image.encode` writes JPEG, and PNG of an opaque image, with the browser's own encoder. A worker writes PNG with alpha and WebP, lossless as before. JPEG blends pixels that are not opaque over black.
- Changed: on a flat map, an area keeps the triangles of its own points. Before, the earth split every triangle along a 2° grid in either projection: the US states took 30,102 triangles on the Mercator map and now take 10,684. The globe still splits them, and changing a scene's projection shapes its areas and lines again.
- Removed: in Rust, `Job::encode` and `Job::geojson`. `Browser` no longer runs a job on the page without `set_jobs`.
- Fixed: places and shapes that arrive for rows that had none begin no transition, since those rows drew nothing to ease from. Before, a view with no camera framed a layout that ran in a job only once the scene's ease had passed, 0.3 s by default, and a view kept drawing that long after its areas appeared.
