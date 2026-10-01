# Scale verification

These fixtures assess the model contract and connect runtime with substantial native data. They are
not shipped and do not add public APIs, a production solver, or a general query engine.

## Run

From the repository root:

```sh
pnpm exec vitest run --project @latkit/model --project @latkit/connect
pnpm --filter @latkit/connect bench:scale
```

The benchmark defaults to 100,000, 1,000,000 and 4,000,000 rows, three repetitions of each warm scan,
and five paths: local, structured-clone messages, binary-framed messages, a real Node worker, and
real loopback TCP using the public ByteChannel API. It writes output/model-connect-performance.json.
Worker code is bundled into output/model-connect-worker. Neither artifact is tracked or published.
No timing threshold runs in ordinary CI.

Optional PowerShell configuration:

```powershell
$env:LATKIT_SCALE_ROWS = '1000000,4000000,8000000'
$env:LATKIT_SCALE_REPEATS = '5'
pnpm --filter @latkit/connect bench:scale
```

Row counts must be integers from 10,000 through 16,000,000; repeats from 1 through 20. Eight million
rows can retain 192 MB of observations alone. Choose sizes appropriate to the available memory.
The benchmark runs serially with exposed GC between scenarios. It uses only existing workspace tools.

## Fixture and independent checks

The implementation lives in packages/model/tests/scale:

- store.ts: lazy 8,192-row numeric pages, generated stable IDs and immutable published data, plus
  frame accounting that counts each native frame once however many holders keep it.
- source.ts: bounded row/sample streams, selection, filtering, sorting, aggregation, version pinning,
  owned buffers, read cancellation and release. Dense reads use subarrays; sparse reads gather.
- model.ts: ordinary Model/Recording implementations; real asynchronous computation that runs one
  command at a time, and monitors that share its immutable outputs and start over for each command.
- verify.ts: an independent value oracle plus canonical validators. It checks every value, ordered
  row coverage, sample tile coverage, IDs, query headers and block bounds; it never collects a whole
  result into a second dataset.

Tests use an uneven 1,000,003-row dataset to exercise page tails, and smaller large datasets for
compound scenarios. They cover commands beside pinned reads, monitors that start over for each
command, transferable ownership, sparse identity reads, filtered ordering, aggregation, empty results,
backpressure, genuine blocked-pull/command cancellation, retained borrowed views, concurrent readers
with a 32 KiB connection budget, and connection shutdown during active work. Million-row retained
reads are checked after the next command and after their monitor closes; nested acquisitions release
independently without duplicating native payloads.
Worker control messages are confined to the fixture harness; no diagnostics or pause methods are
added to the public contract. The TCP channel handles fragmented and coalesced length-prefixed frames
under a fixed allocation bound. It supplies transport errors as disconnected failures. A local hard
close may produce a TCP reset; the shutdown test checks native cleanup after that terminal result.

## Measurements

The report records environment and configuration, cold and repeated warm scan timings, first data
block latency, throughput, per-block bytes, sparse read latency, command time, sample-read time,
retained acquisition time, retained reads after the monitors close, blocked-pull
cancellation latency, copy counters and sampled memory. Every timed
scan includes all canonical validation and independent per-cell checks. Timings therefore describe
this complete verified consumption path, not raw transfer bandwidth or solver speed.

Deterministic assertions, rather than speed thresholds, enforce the important allocation properties:

- Local contiguous borrowed reads copy zero numeric payload bytes.
- Owned scans copy exactly one numeric payload in this retaining implementation. Message/worker
  transports also require that ownership copy for a caller requesting borrowed results.
- Opening monitors does not clone input arrays.
- Two monitors of one command share the same output backing.
- Acquiring a retained Queryable executes no query and copies no numeric payload; shared native
  backing stays allocated only until its final retaining acquisition is released.
- Closing/cancelling leaves no active fixture queries, acquisitions or retained frames.

Counters distinguish input-page generation, owned payload copies and sparse gathers.
They do not count all allocations: ID construction, query-planning arrays, metadata, framing,
structured-clone internals and kernel copies are separate. Framed paths report encoded traffic bytes;
TCP also reports bytes copied to reassemble frames. These are not a universal total-copy metric.

RSS is process-wide and includes workers. External/arrayBuffers figures describe the host isolate,
not worker heaps. Memory peaks sampled every 5 ms and at phase boundaries are lower bounds, not hard
process-memory guarantees. Consumer-held borrowed buffers can outlive native retention.

## Scope and next measurements

This fixture has one numeric component type, one input and one observed field. It advertises only
rows, aggregate and (on recordings) samples. Its simple filter/sort implementation uses temporary
selection arrays; sparse monitors retain and honestly charge full native frame allocations. Neither
choice is a proposed production query planner. Retained input admission conservatively reserves
the lazily generated inputs; defaults are 256 MiB per grant and 512 MiB shared across the fixture
model. Those fixture defaults are not mandated by the public contract. Its stream export is
test-only, not an archive codec.

The existing small conformance fixtures remain responsible for broad layout/connectivity coverage.
Before production cutover, reuse these checks against a real implementation and add:

1. Large strings, nested columns, nullable fields, wide tables and high-degree segmented topology.
2. Lazy file-backed paging under large I/O workloads.
3. Browser Workers and deployed WebSockets, with realistic latency, slow readers and disconnects.
   Loopback TCP tests framing and the ByteChannel extension point, not a production network.
4. Sustained long commands, native solver memory budgets and a real co-simulation peer's
   timing/synchronization behavior.
5. Consumer/GPU query caching, incremental updates, upload counts and time to visible output.

Treat the report as a reproducible baseline on its recorded machine. Keep raw trials and compare
like-for-like runs before changing block sizes, credit scheduling, caching or the contract itself.
