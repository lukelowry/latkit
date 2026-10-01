# @latkit/monitor example

Synthetic live telemetry using native `Queryable` sample blocks, GPU color scales,
`createMonitor({ gpu, data, options })`, `createCanvasView`, and `attachMonitorInput`.
The example owns the source, GPU and canvas lifecycle. Pausing stops data production;
inspection and resizing remain available. Appends publish immutable frame buffers.

```sh
pnpm install
pnpm --filter @latkit/monitor-example dev
```

Builds model, GPU, and monitor, then serves http://127.0.0.1:5190.
Signal switching, palette selection, exact readings, row focus, automatic domains,
follow mode, custom shading, reset, and stream rate controls use the current public API.

```sh
pnpm --filter @latkit/monitor-example build
pnpm --filter @latkit/monitor test:browser --headed --keep-open
```

The second command runs the package's headed GPU checks and benchmarks.

Open `/check.html` and run the GPU history check to compare 90 versus 900 frames,
including selected-row appends. `pnpm --filter @latkit/monitor-example test` checks
native sample validity, retention, cancellation, owned buffers, and block limits.
Single-frame reads borrow published backing; history reads pack at most 64 frames
per bounded rectangle to avoid one query/upload/draw operation per historical frame.
