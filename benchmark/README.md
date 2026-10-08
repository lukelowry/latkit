# Benchmarks

Each `*.bench.ts` times one package, or several together, through public entry points only, at
several sizes, such as 10 thousand to a million buses. A null WebGPU device (`device.ts`) does no
GPU work, so the benchmarks time the JavaScript a frame costs and need no GPU. Real GPU timings come
from each package's browser check. Text goes through a fixed-metric rasterizer, so the benchmarks
count rasterizations rather than timing fonts.

```sh
pnpm bench          # build, then run every benchmark
pnpm bench:update   # also record each benchmark's work per run in work.json
pnpm bench:gate     # run, then check against .bench/base.json and work.json
```

## Gate

The gate (`gate.ts`) fails when a benchmark does not complete, or when its work per run grows past
`work.json`. Work is exact on any machine: queries, uploads, and their cache hits; uploaded, staged,
and copied bytes; allocations, submissions, evictions, rasterizations, and vertices drawn. The null
device counts each draw's vertices times its instances; indirect draws count none. Commit
`work.json` with the change that moves it. CI gates every pull request.

Timings vary between runs, even on one machine, so the gate only reports them:

- benchmarks whose fastest and median runs are both more than 25% slower than `.bench/base.json`;
- time per item that grows more than 3× from the smallest size to the largest: cache misses alone
  can double it across a 100× range, while quadratic work multiplies it by a hundred.

To record a base, run `pnpm bench --outputJson .bench/base.json` on the base branch. Without it,
the gate skips that comparison. Compare timings by running the base and the change alternately,
several times each.
