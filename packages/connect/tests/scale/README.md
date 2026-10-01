# Scale checks

```sh
pnpm exec vitest run --project @latkit/model --project @latkit/connect
pnpm --filter @latkit/connect bench:scale
```

The benchmark checks 100K, 1M, and 4M rows over local calls, messages, binary frames,
a Node worker, and loopback TCP. An independent oracle checks values, coverage,
byte limits, retention, and cleanup. Results go to
`output/model-connect-performance.json`.

```powershell
$env:LATKIT_SCALE_ROWS = '1000000,4000000'
$env:LATKIT_SCALE_REPEATS = '5'
pnpm --filter @latkit/connect bench:scale
```

Rows must be 10,000?16,000,000; repetitions 1?20.
Timings include validation and have no CI speed threshold.

The test model uses numeric pages and shared immutable frames; it is not a
production query engine. Copy counters cover fixture payloads, not all runtime
or kernel allocations. Sampled memory peaks are lower bounds.
Compare reports from equivalent machines and workloads.
