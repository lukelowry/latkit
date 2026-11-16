---
'latkit': minor
---

The module that draws is a tenth smaller: jobs run in a module of their own, pictures are encoded by the browser, and flat maps keep areas as they are.

- Added: `latkit/jobs`, the WebAssembly that does the work views and datasets hand to workers: layouts, lanes, triangles, tile pyramids, and decoding vector tiles and GeoJSON. A page loads it with its first job. `load({ jobs })` takes its URL or the compiled module. A page that passes asset URLs to `load` passes this one too.
- Added: in Rust, `Host::encode` encodes a picture as a file, and `host::read` reads a dataset with GeoJSON parsed in a job.
- Changed: `latkit/wasm` is 3.50 MB, 1.12 MB with brotli. It was 3.89 MB and 1.23 MB. Workers load the 0.59 MB jobs module (0.19 MB with brotli) in place of a second copy of it.
- Changed: every job runs in a worker. Before, a small one ran on the frame that asked for it, so a small scene now draws its lanes, triangles, or layout a frame or more after its first frame.
- Changed: in Node, `Data.read` reads GeoJSON only after `load({ wasm, jobs })` with the jobs module compiled like the first.
- Changed: `image.encode` writes PNG, JPEG, and WebP with the browser's own encoder. WebP is written at full quality, which is lossless in Chrome. A browser that cannot write a format, as Safari cannot write WebP, rejects with an `unsupported` error. Where a pixel is not opaque, its color may differ by a step.
- Changed: on a flat map, an area keeps the triangles of its own points. Before, the earth split every triangle along a 2° grid in either projection: the US states took 30,102 triangles on the Mercator map and now take 10,684. The globe still splits them, and changing a scene's projection shapes its areas and lines again.
- Removed: in Rust, `Job::encode` and `Job::geojson`. `Browser` no longer runs a job on the page without `set_jobs`.
