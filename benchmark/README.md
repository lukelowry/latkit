# Benchmark

The benchmark runs each scenario in Chrome, or another browser, at increasing sizes. It measures
each phase's time, CPU and GPU time per frame, GPU work, and WebAssembly memory, and checks them
against committed baselines. The page steps every frame itself: each frame starts when the GPU has
finished the last one, not on the display's clock, so a run draws the same frames on any device.
GPU time comes from WebGL2 timer queries (`EXT_disjoint_timer_query_webgl2`). The browser gate
(`npm/examples/gate/gate.ts`) checks frame pacing.

```sh
cargo xtask bench --quick            # each scenario once at its smallest size: phases and work
cargo xtask bench                    # every size while the last fits at its fastest, 3 repeats
cargo xtask bench --only grid,labels # some scenarios
cargo xtask bench --software         # SwiftShader on the CPU: work is judged, times only reported
cargo xtask bench --firefox --quick  # Firefox (or --webkit) instead of Chrome
cargo xtask bench --update           # lay this run's results over the baselines
```

`LATKIT_ANGLE` picks the backend Chrome draws with (`d3d11`, `vulkan`, `gl`, or `metal`). Each
backend and browser reports its own renderer, so each keeps its own times baseline. Work counts
don't depend on the device, so every browser is held to the one work baseline. Playwright installs
Firefox and WebKit with `pnpm --dir npm/examples exec playwright-core install firefox webkit`.

A run fails on:

- An error, a frame drawn when nothing changed, a pipeline compiled when first used (`late`), or
  resident data over its budget.
- A phase whose time or uploaded bytes grow with size faster than its declared order. For loading,
  resident bytes and WebAssembly memory count too. Each upload (`uploads`) counts as at least one
  page of bytes. A steady phase's GPU time per frame may grow at most linearly, unless it declares
  less.
- More work than `baselines/work.json`. In a phase that acts once, counts set by the data alone
  (`uploaded`, `uploads`, `evaluated`, `packed`, `jobs`, `pipelines`, `late`, `resident`) may not
  exceed the baseline. All other counts may reach 2× the baseline, because they depend on which
  frame a job finishes in. These are `written`, `resolved`, `cleared`, `readbacks`, and `texts`,
  and every count in a phase that acts each frame. In a scenario fed by fetches, every count may
  reach 3×. WebAssembly memory may reach 1.25× the baseline plus 1 MiB (3× with fetches).
- In a full sweep on a GPU, a phase whose fastest repeat takes more than 1.25× its time in that
  GPU's baseline, `baselines/<renderer>.json`, plus one timer tick (16 ms) for a phase that acts
  once, and five (80 ms) for loading, which finishes up to 70 ms either side between sweeps. A
  steady phase's slowest frames (the 95th percentile) may take 1.5×. Its GPU time per frame may
  take 3× plus 1 ms: the GPU lowers its clocks between stepped frames, so that varies severalfold
  between sweeps, and only a blowup is a regression. Locking the clocks first (as administrator,
  `nvidia-smi --lock-gpu-clocks=<MHz>` on NVIDIA) makes GPU times compare closely. Only the fastest
  repeat counts, so a machine stall that slows one repeat does not fail the run. A real regression
  slows every repeat.
- A phase measured without a baseline, or a full sweep on a GPU without a times baseline, until a
  run with `--update` records one. A faster machine that reaches a larger size than the baseline
  has only notes it.

Cold scenarios (`start`, `start globe`, `start labels`, `start markers`) open in a fresh browser
without a shader cache, as a first visit does. A scenario that moves on its own, such as `comets`,
settles once a frame after each action is complete.

On a machine with two GPUs, the runner makes Chrome draw on the faster one. Reports and results go
to `target/bench/`. Scenarios are in `page/scenarios.ts`, the data they draw in `page/data.ts`, and
how a phase is measured in `page/stage.ts`.
