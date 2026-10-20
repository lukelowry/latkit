# Benchmark

Each scenario's phases, up its sizes, in Chrome: time, GPU time, stalls, and the work the GPU did,
held to committed baselines.

```sh
cargo xtask bench --quick            # each scenario once at its smallest size: a smoke test
cargo xtask bench                    # every size while the last fits, 3 repeats
cargo xtask bench --only grid,labels # some scenarios
cargo xtask bench --software         # SwiftShader on the CPU: work is judged, times only reported
cargo xtask bench --update           # lay this run's results over the baselines
```

A run fails on:

- an error, a frame drawn while nothing changed, or resident data over its budget;
- a phase growing with size faster than its order;
- more work than `baselines/work.json`: exactly for what the data sets (`uploaded`, `evaluated`,
  `jobs`, `pipelines`, `resident`) in a phase that acts once, and within 2× for what moves with how
  fast readbacks land (`written`, `readbacks`, `texts`, and every count of a phase acting each frame);
- on the machine `baselines/<machine>.json` was taken on, a phase over 1.25× slower, and for a phase
  acting once, later by over a timer tick (16 ms).

On a machine with two GPUs, Chrome draws on the fast one. Reports and results land in
`target/bench/`. Scenarios are in `page/scenarios.ts`, the data they
draw in `page/data.ts`, and how a phase is measured in `page/stage.ts`.
