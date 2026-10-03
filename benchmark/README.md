# Benchmarks

Each `*.bench.ts` times one package, or the packages together, through public entry points only, at
10 thousand, 100 thousand, and a million buses. A null WebGPU device (`device.ts`) does no GPU work,
so these time the JavaScript a frame costs and need no GPU. Real GPU timings live in each package's
browser check.

```sh
pnpm bench          # build, then run every benchmark
pnpm bench:update   # also record each benchmark's work per run in work.json
pnpm bench:gate     # run, then check against .bench/base.json and work.json
```

The gate (`gate.ts`) fails when work per run grows: queries, uploads, uploaded and copied bytes,
allocations, submissions, or evictions, which are exact on any machine. Commit `work.json` with the
change that moves them. CI gates every pull request this way.

Timings vary between runs, even on one machine, so the gate only reports them:

- benchmarks whose fastest and median runs are both more than 25% slower than `.bench/base.json`;
- time per item that grows more than 3× from the smallest size to the largest: cache misses alone
  can double it across a 100× range, while quadratic work multiplies it by a hundred.

Compare timings by running the base and the change alternately, several times each.
