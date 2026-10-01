# @latkit/model

The model contract: one root import, native domain interfaces, explicit validation and native
column access utilities. A Model is a grid model: its classes and data, the commands it runs, and
monitors on what those commands compute. A Recording is a monitor. Both are read through Queryable.

This package replaces the previous model implementation. Consumers still require migration to this
contract. The package remains private while implementation and integration work continues.

## Boundaries and ownership

| Interface | Responsibility                                                            | Lifetime                                                   |
| --------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Model     | Classes (describe), data (query), routines, monitor() and run()           | Shared by every holder; closing ends one holder's use      |
| Recording | A monitor: the frames of its fields for the latest command, readable live | Its holder's; starts over for each command until it closes |
| Queryable | Discovery, bounded query streams and independent retained reads           | A Model, a Recording, or an independently retained source  |

Opening a model, changing its file, access and sharing belong to its application. Nothing is reached
by id: anything that lives as long as someone holds it is reached through the object they hold. The
same Model works in-process, in a worker, or through @latkit/connect.

## Host usage

```ts
import type { Model, Queryable } from '@latkit/model';

/** Monitor once, bind the views once, then run as often as you like. */
async function study(model: Model, signal: AbortSignal): Promise<Queryable> {
  const schema = await model.describe(); // The classes; sampled fields are what can stream.
  const buses = await model.monitor([{ from: 'Bus', select: ['Vm', 'Va'] }]);
  buses.on('change', (update) => {
    if (update.kind === 'replace') console.log('a command started it over');
    if (update.kind === 'append') console.log(update.frames.offset, update.frames.count);
  });
  const fault = { tmax: 10, fault: true, fault_start: 1, fault_duration: 0.1 };
  await model.run(
    { routine: 'dynamic-simulation', values: { ...fault, fault_bus: 'Bus/16' } },
    { signal },
  );
  const first = await buses.retain(); // Keep these frames past the next command.
  await model.run(
    { routine: 'dynamic-simulation', values: { ...fault, fault_bus: 'Bus/21' } },
    { signal },
  );
  console.log(schema.components, buses.status, buses.frames, buses.range, buses.diagnostics);
  return first;
}
```

## Monitors and commands

describe() returns the model's classes: components, connections and tables, with their fields and
ports. Fields declared sampled are what monitor() can stream; a model holds no observations of them.
routines lists what run() accepts; it is fixed for the model's lifetime and empty when the model
computes nothing.

monitor(fields) returns a Recording that streams those fields of every command that starts after the
call. It is idle until one starts. Each command whose routine records starts it over: the recording
emits replace and then appends that command's frames as they are computed. Routines that do not
record leave monitors as they are. A monitor opened while a command runs waits for the next one.
Rows resolve when it opens; unknown rows and fields that are not sampled reject invalid-input.

run(command) runs one command. Commands run one at a time, in the order given. A command runs on the
data current when it starts, and every monitor open then streams it, whoever ran it. run() rejects
invalid-input, with issues, before anything runs, and resolves with the command's result once every
frame is published. Aborting its signal cancels it, queued or running; frames already recorded stay
readable. A lost reply may have run, so never retry blindly.

A monitor's status, progress and diagnostics are those of the command it shows. Frames are never
evicted: [0, frames) stays readable until the next command starts it over or it closes. Closing a
monitor ends its stream, never the command. retain() fixes the frames it holds as an independent
source, so one command's frames can be compared with the next. export() writes them, with their
coordinates and command, as one Arrow IPC stream.

## Retained reads

For a coherent multi-query operation, acquire the same Queryable interface at a fixed version:

```ts
const source = await recording.retain({
  window: { kind: 'range', between: [100, 200], context: { before: 1, after: 1 } },
  maxBytes: 512 * 1024 * 1024,
});
try {
  for await (const block of source.query({
    kind: 'samples',
    from: 'Bus',
    select: ['Vm'],
    window: { kind: 'range', between: [100, 200] },
  })) {
    if (block.kind !== 'schema') console.log(block.coordinates, block.columns.Vm);
  }
} finally {
  await source.close();
}
```

retain fixes schema, data, row identities and recorded observations atomically. Omitting window
retains every recorded frame; a model's data has no window. Range context resolves once at
acquisition. Queries resolve against that fixed observation index and reject invalid-input if any
selected frame lies outside the grant; they never clip missing frames to it. Appends and a monitor
starting over never alter it. A nested retain is independent and can only preserve or narrow
coverage. Retained sources emit closed only, with no data changes. A retained source survives the
acquisition it came from and its model's close.

Admission performs no query execution or result materialization. Native page/index references can be
shared; acquiring data does not require duplicating its payload. maxBytes accounts for protected
backing and indexes, including whole allocations behind sparse slices. Implementations impose finite
default and shared budgets and deduplicate shared backing in global accounting. Conservative storage
reservations are allowed; resource-limit leaves no acquisition. The signal applies to admission only.
Closing a source cancels its direct queries; independently retained children and issued blocks
survive.

## Schema and physical format

Schema describes components, connections, ordinary tables, numeric/text/boolean/reference fields,
fixed numeric vectors, lists, ports and roles. It is fixed for the life of its Model or Recording.
Optional spatial metadata identifies domain coordinates, never application styling. Bounds use
lower/upper edges with explicit inclusivity and describe scalar numeric data. Diagnostic targets
distinguish elements, fields, ports, parameters, and structural paths.

IDs are model-wide domain identities. Index = { source, type, version } names a physical row
numbering in one Model or Recording; source is that object's opaque identity. A replaced model
numbers its rows anew. Recordings keep the index definitions of the data their command ran on.
Implementations reject stale indices; validators cannot infer membership from metadata alone.

Rows query by IDs, physical range, or versioned Uint32 indices. A cached range may carry an Index too.
Returned RowAxis uses an allocation-free range or explicit Uint32 indices when needed. Physical order
is the default. Stable ID strings are emitted only when requested, as UTF-8 columns. Endpoints use
columnar CSR segments, including partial segments of very large relationships. Links optionally
project two ports through a declared connection type, with explicit missing/ambiguous semantics. No
object-per-endpoint topology, implicit geometry, or mandatory lexical sort is required.

Columns use a small Arrow-compatible physical subset, not Arrow JS objects or Arrow IPC:

- Numeric values use Float32Array, Float64Array, Int32Array, or Uint32Array.
- Boolean values and validity use least-significant-bit-first bitmaps.
- Text uses UTF-8 bytes with signed 32-bit offsets and a terminal offset.
- Vectors address numeric child slices; lists address child columns through signed 32-bit offsets.
- Column offset applies to both values and validity. Child addressing is defined in data.ts.
- List items and vector lanes are non-nullable; parent values may be null. Nesting is limited to 32.
- Input numbers and sample coordinates are finite. Native sampled floats may be nonfinite;
  aggregates exclude nonfinite values. Null payloads and sample stride padding are ignored.

One physical row axis fits Uint32; one column slice/offset fits signed Int32. Larger datasets must
partition their types/blocks. Strings or lists larger than a block's bound reject resource-limit.
These limits are explicit and do not silently downcast identities or offsets.

## Streaming and buffers

Each query iteration fixes one version on first pull, and releases request resources on completion,
return, throw, or abort. Aborting must also interrupt a pending pull. A stream may fail after yielding
valid blocks; consumers must not treat a partial stream as complete. Exactly one QueryHeader precedes
data, including empty reads. It pins Schema and data Version atomically; describe() is for discovery,
not a prerequisite or substitute for this header. Empty reads have no data blocks, except requested
row counts and empty aggregate results. Rows are never repeated across blocks; sample tiles cover the
requested frame/row rectangle exactly once. Data and index versions remain coherent throughout the
stream. Separate queries do not implicitly share a pinned version.

A coordinate-range window may request context: { before: 1, after: 1 } to include neighboring
observations for continuity across its boundaries. Omitted counts are zero; counts must be
nonnegative safe integers. The inclusive interval includes all duplicate boundary coordinates.
Context counts individual frames strictly outside it, choosing the nearest recorded frames on each
side even when the interval contains no observations. Extra context clips to recorded bounds and
never waits for future frames. An empty recording has no context. Sample and aggregate queries use the
same expanded window, resolved against their pinned read. Implementations should locate bounds
through their coordinate index, without scanning observations or copying numeric payloads merely to
add context.

maxBlockBytes is bounded by Schema.limits.maxBlockBytes. blockByteLength gives the exact contract
accounting: exposed byte-range unions, UTF-8 metadata including keys, eight bytes per number, and
one byte per boolean/null. Shared metadata objects are counted once. This deliberately differs from
transport framing and allocated memory. blockBuffers returns deduplicated backing allocations, which
can be much larger than the views. Owned blocks must also fit the same bound when counting full
backing allocations; a thin slice of a large retained buffer is not an owned block. Bounds are checked
before column value scans. Schema headers and transport envelopes require separate metadata limits at
the transport boundary.

Default borrowed blocks remain immutable and valid after close. Neither side may detach their
backing. For buffers: 'owned', the implementation must relinquish every backing allocation and all
aliases; no SharedArrayBuffer or alias into another block may remain. The consumer can then transfer
blockBuffers(block). Asking for owned data can require a copy when storage retains it. Contiguous
borrowed reads can expose native subarrays; sparse gathers, sorting, and ownership conversion may copy.
This contract permits zero-copy paths without claiming every path is zero-copy.

For sampled reads, omitted rows mean the physical-order intersection of the selected fields' coverage;
explicit rows must be covered for every selected field. Each SampleColumn has its own strides, so
different field orientations need no shared-layout repacking. Coordinates are domain-neutral; the
recording schema's axis names them. Consumer-held borrowed buffers can outlive a recording and keep
allocations alive.

## Optional history envelopes

A sampled `Queryable` may advertise `envelope` alongside `samples`. `EnvelopeQuery` selects a
coordinate range, rows, scalar fields, and an equal-coordinate bucket count. `EnvelopeBlock`
contains native numeric first/minimum/maximum/last values, Float64 coordinates and absolute frames,
and continuity bits. Slots use row-major bucket order. Gaps are explicit; a summary never invents
an observation or renumbers a frame. Empty buckets are emitted invalid. The query and block
interfaces specify boundary inclusion, ties, context, tiling and coverage precisely.

Implementations can use indexed history storage to answer this query efficiently. It is optional;
GPU supplies a bounded raw-sample fallback for ordinary sources. Connect transports the same native
arrays without another envelope contract. Presentation resolution, simplification and hit testing
remain consumer concerns.

## Runtime utilities and verification

Runtime exports cover boundary validation and native access:

```ts
validateSchema(candidate); // readonly Problem[]; no mutation
validateQuery(schema, candidateQuery); // schema must already be validated
validateBlock(schema, query, candidateBlock, queryOptions);
blockByteLength(block);
blockBuffers(block);
sameIndex(a, b);
assertIndex(a, b);
rowCount(rows);
rowAt(rows, position);
sliceRows(rows, offset, count);
bitAt(bitmap, absolutePosition);
numberAt(column, position);
textAt(column, position);
sampleAt(column, { row, frame });
```

Validation is explicit boundary work, not a hidden scan on every local read. It checks declared
layouts, dictionaries, masks, coordinates, strides, selected fields, known index associations,
capabilities, and payload limits. It does not prove exclusive ownership, native referential integrity,
whole-stream coverage, cancellation responsiveness, or command isolation. Those are implementation
obligations exercised by behavioral tests.

The tests include deliberately narrow test implementations, not a production in-memory Model. They
exercise numeric filtering/sorting/pagination/aggregation, schema headers and empty reads, monitors
that start over for each command, commands that run one at a time, queued/running cancellation,
failures and their diagnostics, sparse recorded coverage, coordinate windows, retained reads, tiled
coverage, pending reads, and ownership. A native CSR fixture derives endpoint segments and
missing/ambiguous links from its stored arrays. Nested buffers and independent field strides have
separate layout fixtures. The separate @latkit/connect package tests remote behavior over message and
framed transports. Allocation assertions cover contiguous borrowed reads, sparse gathers, ownership
copies, and backing/view accounting.

Run pnpm --filter @latkit/model build, typecheck, and test.

## Remaining implementation and migration work

1. Implement a real model against this contract and run the same behavioral obligations against
   native commands, cancellation during queued/running work, and large segmented connectivity. Test
   fixtures cover their advertised narrow schemas; they are not a production query engine.
2. Integrate @latkit/connect with actual worker/socket deployment. Supply authentication,
   authorization and reconnection policy in that deployment; migrate consumers directly.
3. Move the GPU/playback query cache and index mapping into one shared consumption path. Reimplement
   network, diagram, monitor, and other consumers directly against Queryable and these columns.
   Application history/layout/catalog state stays outside the contract.
4. Measure large real datasets across local, worker, socket, and export paths: copied bytes,
   retained allocations, time to first block, cancellation latency, and GPU upload counts. Complete
   consumer migration and verify correctness and performance before publishing this package.

## Large-data verification

The test-only paged ScaleModel in tests/scale runs million-row ownership, shared-frame and
one-at-a-time command checks. Its independent oracle is also used across five connect paths. Run the
separate benchmark with pnpm --filter @latkit/connect bench:scale; methodology and scope are
documented in ../connect/tests/scale/README.md. No scale fixture is exported by this package.
