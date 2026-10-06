# Benchmarks

Each `*.bench.ts` times one package, or the packages together, through public entry points only, at
10 thousand, 100 thousand, and a million buses. A null WebGPU device (`device.ts`) does no GPU work,
so these time the JavaScript a frame costs and need no GPU. Real GPU timings live in each package's
browser check.

Diagram workloads cover 100 through 40,000 blocks, including playback of a sampled color, which the
GPU restyles without rereading the scene. The 40,000-block stress case explicitly uses a
128 MiB picking budget; the library default remains 32 MiB. Text workloads measure cold glyph
creation and resident reuse across 1,000 labels. The fake rasterizer measures reuse and call counts,
not browser font shaping or rasterization speed.

```sh
pnpm bench          # build, then run every benchmark
pnpm bench:update   # also record each benchmark's work per run in work.json
pnpm bench:gate     # run, then check against .bench/base.json and work.json
```

The gate (`gate.ts`) fails when work per run grows: queries, uploads, uploaded and copied bytes,
allocations, submissions, evictions, rasterizations, or vertices drawn, which are exact on any
machine. The null device counts each draw's vertices times its instances, the GPU work a frame
asks for; indirect draws count none. It also rejects incomplete timing reports. Commit `work.json`
with the change that moves them. CI gates every pull request this way.

Monitor workloads run each trace setup, fixed colors and colors mapped from a field, one trace or
four, through the changes an application makes: streaming, recoloring, selecting, moving the
window, and animating a shade.

Timings vary between runs, even on one machine, so the gate only reports them:

- benchmarks whose fastest and median runs are both more than 25% slower than `.bench/base.json`;
- time per item that grows more than 3× from the smallest size to the largest: cache misses alone
  can double it across a 100× range, while quadratic work multiplies it by a hundred.

Compare timings by running the base and the change alternately, several times each.
