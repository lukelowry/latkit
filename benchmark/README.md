# Benchmark

The benchmark runs each scenario in Chrome at increasing sizes. It measures each phase's time, GPU
time, and GPU work, and checks them against committed baselines. The page steps every frame itself:
each frame starts when the GPU has finished the last one, not on the display's clock, so a run draws
the same frames on any device. The browser gate (`npm/examples/gate/gate.ts`) checks frame pacing.

```sh
cargo xtask bench --quick            # each scenario once at its smallest size: phases and work
cargo xtask bench                    # every size while the last fits at its fastest, 3 repeats
cargo xtask bench --only grid,labels # some scenarios
cargo xtask bench --software         # SwiftShader on the CPU: work is judged, times only reported
cargo xtask bench --update           # lay this run's results over the baselines
```

A run fails on:

- An error, a frame drawn when nothing changed, a pipeline compiled when first used (`late`), or
  resident data over its budget.
- A phase whose time or uploaded bytes grow with size faster than its declared order. For loading,
  resident bytes count too. Each upload (`uploads`) counts as at least one page of bytes.
- More work than `baselines/work.json`. In a phase that acts once, counts set by the data alone
  (`uploaded`, `uploads`, `evaluated`, `packed`, `jobs`, `pipelines`, `late`, `resident`) may not
  exceed the baseline. All other counts may reach 2× the baseline, because they depend on which
  frame a job or fetch finishes in. These are `written`, `resolved`, `cleared`, `readbacks`, and
  `texts`, every count in a phase that acts each frame, and every count in a scenario fed by
  fetches.
- In a full sweep on the machine that recorded `baselines/<machine>.json`, a phase whose fastest
  repeat takes more than 1.25× its baseline, plus one timer tick (16 ms) for a phase that acts
  once. Only the fastest repeat counts, so a machine stall that slows one repeat does not fail the
  run. A real regression slows every repeat.

On a machine with two GPUs, the runner makes Chrome draw on the faster one. Reports and results go
to `target/bench/`. Scenarios are in `page/scenarios.ts`, the data they draw in `page/data.ts`, and
how a phase is measured in `page/stage.ts`.
