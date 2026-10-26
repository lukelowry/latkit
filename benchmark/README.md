# Benchmark

The benchmark runs each scenario in Chrome at increasing sizes and measures each phase's time, GPU
time, and GPU work, checked against committed baselines. The page steps every frame itself, starting
each one when the GPU has finished the last rather than on the display's clock, so a run draws the
same frames on any device. Frame pacing is judged by the browser gate (`npm/examples/gate/gate.ts`)
instead.

```sh
cargo xtask bench --quick            # each scenario once at its smallest size: phases and work
cargo xtask bench                    # every size while the last fits at its fastest, 3 repeats
cargo xtask bench --only grid,labels # some scenarios
cargo xtask bench --software         # SwiftShader on the CPU: work is judged, times only reported
cargo xtask bench --update           # lay this run's results over the baselines
```

A run fails on:

- An error, a frame drawn while nothing changed, a pipeline compiled where it was first used
  (`late`), or resident data over its budget.
- A phase whose time or uploaded bytes (and, for loading, resident bytes) grow with size faster
  than its declared order. Each upload (`uploads`) counts as at least a page of bytes.
- More work than `baselines/work.json`. In a phase that acts once, the counts the data alone sets
  (`uploaded`, `uploads`, `evaluated`, `packed`, `jobs`, `pipelines`, `late`, `resident`) may not
  exceed the baseline. The other counts (`written`, `resolved`, `cleared`, `readbacks`, `texts`),
  every count of a phase that acts each frame, and every count of a scenario fed by fetches may
  reach 2× the baseline, since they depend on which frame a job or fetch finishes in.
- In a full sweep on the machine that recorded `baselines/<machine>.json`, a phase whose fastest
  repeat is more than 1.25× slower than its baseline, plus one timer tick (16 ms) for a phase that
  acts once. Judging the fastest repeat means a stall of the machine, which slows one repeat, does
  not fail the run; a regression slows every repeat.

On a machine with two GPUs, Chrome is made to draw on the faster one. Reports and results are
written to `target/bench/`. Scenarios are defined in `page/scenarios.ts`, the data they draw in
`page/data.ts`, and how a phase is measured in `page/stage.ts`.
