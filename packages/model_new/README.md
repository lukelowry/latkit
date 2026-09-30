# @latkit/model-new

Candidate replacement for the model contract. One root import, native domain interfaces and five
explicit boundary utilities. Documents have shared identity and independent acquisitions. Models
retain a Document and own computation. Recordings retain captured inputs and observations.
ModelService provisions these objects without becoming another execution layer.

The existing model and consumers remain unchanged. This candidate stays private until cutover.

## Boundaries and ownership

| Interface    | Responsibility                                                                 | Lifetime                                                            |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| ModelService | Implementation identity, formats, open a Document, acquire a Document or Model | Application-managed service                                         |
| Document     | Schema, queries, domain edits, optional persistence                            | Each acquisition closes independently; Models retain shared inputs  |
| Model        | Routines, optional parsing and validation, commands, monitoring, reset         | One independent compute context or exclusive live-peer binding      |
| Recording    | Queryable captured data, command provenance, diagnostics, export               | Model-owned; stop preserves data, close releases it                 |
| Resource     | Access to one application-owned byte sequence                                  | Distinct grant per lend; recipient closes after use or failed setup |
| Queryable    | Discovery and bounded canonical query streams                                  | Implemented directly by Document and Recording                      |

Document.close() releases its acquisition and reads. Other acquisitions and Models remain usable.
Model.reset() cancels that context's work and closes its recordings; shared Document inputs are
unchanged. Model.close() also releases its Document retention. The final retention disposes native
state and closes its Resource grant. IDs alone do not grant authority to another application.

ModelService does not require a file or parser. A live/co-simulation implementation may expose
formats: [], Document.format: null, no edit/persistence methods, and only live routines and
monitoring. model(documentId) may reject busy when an external peer permits only one binding.
The same Model interface works locally, through @latkit/connect, or as a supplied native object.
Scheduling, synchronization with an external peer, and supported operations remain implementation
behavior; the contract does not require isolated solving or independent clocks.

## Host usage

An implementation supplies ModelService through ordinary interface implementation. Connection
establishment belongs to @latkit/connect. No registration helper or generic engine wrapper is needed.

```ts
import type { ModelService } from '@latkit/model-new';

async function analyze(service: ModelService) {
  const document = await service.open(); // Optional source; may be hardcoded or live.
  const model = await service.model(document.id);
  try {
    const schema = await document.describe();
    if (!model.call || !model.monitor) return schema;

    const id = crypto.randomUUID();
    const recording = await model.monitor({
      scope: { kind: 'command', id },
      fields: [{ from: 'Node', select: ['output'] }],
      retain: { kind: 'all', bytes: 64 * 1024 * 1024, onLimit: 'fail' },
    });
    try {
      await model.call({ routine: 'solve', values: {} }, { id });
      await recording.ready;
      const outcome = await recording.done;
      if (outcome.status === 'failed') throw outcome.error;

      for await (const block of recording.query({
        kind: 'samples',
        from: 'Node',
        select: ['output'],
        window: {
          kind: 'frames',
          offset: recording.firstFrame,
          count: recording.frameCount - recording.firstFrame,
        },
      })) {
        if (block.kind === 'schema') continue;
        // Canonical columns: consume their offsets, validity and independent strides directly.
        console.log(block.coordinates, block.columns.output);
      }
      return schema;
    } finally {
      await recording.close();
    }
  } finally {
    await model.close();
    await document.close();
  }
}
```

Discover routine IDs, parameters and modes through model.routines. An isolated routine pins inputs
at command acceptance; arming a monitor does not pin them. A queued command already retains its
input version. Later edits or reloads cannot alter it. Routine.monitoring declares command and/or
live capture support; isolation does not promise parallel execution.

Live monitoring uses scope: { kind: 'live' }, binds immediately and ends before inputs change.
Isolated output never enters live capture. stop() stops capture independently of command cancellation.
Command-scoped recording ends after terminal output flush, including failed commands. commands()
reports command outcomes; done reports capture outcome. A command ID is unique for the entire Model
lifetime, including reset and rejected calls. Arm monitors before submitting that ID. Reuse rejects
conflict; failed acceptance fails matching armed monitors. Never retry unknown side effects after a
lost reply.

## Shared editing and persistence

```ts
import type { ModelService, Resource } from '@latkit/model-new';

async function edit(service: ModelService, resource: Resource) {
  const document = await service.open({ kind: 'resource', resource });
  try {
    if (!document.edit || !document.save) throw new Error('Editing and saving are unavailable');
    const change = await document.edit([
      { kind: 'add-component', as: 'new', type: 'Node', values: { value: 3 } },
    ]);
    const assignedId = change.created.new;
    await document.edit([
      { kind: 'assert', id: assignedId, values: { value: 3 } },
      { kind: 'set', id: assignedId, values: { value: 4 } },
    ]);
    const saved = await document.save();
    console.log(saved.version === document.version); // Dirty state after any concurrent edits.
  } finally {
    await document.close();
  }
}
```

open() creates a logical document; document(id) explicitly joins one. Reopening the same source
never implicitly joins shared mutable inputs. Implementations may share immutable parsing/storage
caches. Queries pin coherent versions without requiring eager full-file loading or cloning inputs.

Edits are atomic batches. Assertions inspect pre-edit inputs; aliases resolve throughout the batch;
validation checks the final domain structure. Removals never silently cascade. Change reports native
assigned identities, not undo instructions. Failed assertions are conflict; invalid domain inputs
are invalid-input. History, styling and application catalogs remain outside the contract.

Input also accepts an implementation-defined reference or a one-use content stream. File parameters
use the same Input carrier. validate() performs preflight without consuming content. Command
provenance retains InputMetadata rather than live grants or replay promises. An explicit empty input
selects a creatable format; omitted input is implementation-defined.

Resource exposes stat(), tagged range read(), optional conditional write(), and close(). A tag identifies
exact stored bytes, independently of Document.version. Applications implement storage and access;
Document implementations define format parsing, serialization and reusable ranges. No filesystem,
whole-workspace access, file picker or app save dialog crosses this boundary.

write({ base, parts }) consumes ordered copy/data parts. Copy ranges address the immutable base;
data carries literal bytes. The resource stages separately and publishes atomically only if the base
still matches. base: null requires an absent destination and forbids copy parts. A full rewrite is
simply all data parts. If storage cannot guarantee conditional publication, omit write.

save() pins current inputs at acceptance and serializes saves while editing can continue. saved is
published only after commit and names that input version, which may already differ from the current
version. save({ to: { resource, base } }) retargets shared persistence only after success; failed setup
closes the new grant. A lost response may have committed and must not trigger an automatic retry.

reload() reads the current bound resource atomically; dirty inputs require discardChanges: true.
Edits or binding changes arriving during the read reject conflict even with discard requested.
attach(resource) restores access to the same resource identity after its host disconnects, without
changing inputs or the saved baseline. If storage changed while disconnected, the next save still
fails its base check. Export streams the current version independently of bound storage. Neither
persistent history nor a portable archive codec is implied.

Each acquisition exposes change and saved events after metadata publication. A consumer computes
dirty state using saved === null || saved.version !== document.version. Closing a Resource grant
cancels its I/O without deleting storage. Applications lend a separate grant to every recipient.

## Schema and physical format

Schema describes components, connections, ordinary tables, numeric/text/boolean/reference fields,
fixed numeric vectors, lists, ports, roles, and supported edits. Optional spatial metadata identifies
domain coordinates, never application styling. Bounds use lower/upper edges with explicit
inclusivity. Diagnostic targets distinguish elements, fields, ports, parameters, and structural paths.

IDs are document-wide domain identities and never identify an unrelated entity later in the same
Document lifetime, including reload. Index = { document, type, version } names a physical row
numbering. Input value edits preserve it; changes to membership/numbering replace it. Reload invalidates earlier document indices; Model.reset() preserves them. Recordings retain their original index definitions. Source
implementations reject stale indices; validators cannot infer source membership from metadata alone.

Rows query by IDs, physical range, or versioned Uint32 indices. A cached range may carry an Index too.
Returned RowAxis uses an allocation-free range or explicit Uint32 indices when needed. Physical order is the default.
Stable ID strings are emitted only when requested, as UTF-8 columns. Endpoints use columnar CSR
segments, including partial segments of very large relationships. Links optionally project two
ports through a declared connection type, with explicit missing/ambiguous semantics. No object-per-
endpoint topology, implicit geometry, or mandatory lexical sort is required.

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

## Streaming, buffers, and retention

Each query iteration fixes one version on first pull, and releases request resources on completion,
return, throw, or abort. Aborting must also interrupt a pending pull. A stream may fail after yielding
valid blocks; consumers must not treat a partial stream as complete. Exactly one QueryHeader precedes
data, including empty reads. It pins Schema and data Version atomically; describe() is for discovery,
not a prerequisite or substitute for this header. Empty reads have no data blocks, except requested
row counts and empty aggregate results. Rows are never repeated across blocks;
sample tiles cover the requested frame/row rectangle exactly once. Schema/data/index versions must
remain coherent throughout the stream. Separate queries do not implicitly share a pinned version.

maxBlockBytes is bounded by Schema.limits.maxBlockBytes. blockByteLength gives the exact contract
accounting: exposed byte-range unions, UTF-8 metadata including keys, eight bytes per number, and
one byte per boolean/null. Shared metadata objects are counted once. This deliberately differs from transport framing and allocated memory.
blockBuffers returns deduplicated backing allocations, which can be much larger than the views.
Owned blocks must also fit the same bound when counting full backing allocations; a thin slice of
a large retained buffer is not an owned block. Bounds are checked before column value scans. Schema
headers and transport envelopes require separate metadata limits at the transport boundary.

Default borrowed blocks remain immutable and valid after eviction/close. Neither side may detach
their backing. For buffers: 'owned', the implementation must relinquish every backing allocation and
all aliases; no SharedArrayBuffer or alias into another block may remain. The consumer can then
transfer blockBuffers(block). Asking for owned data can require a copy when storage retains it.
Contiguous borrowed reads can expose native subarrays; sparse gathers, sorting, and ownership
conversion may copy. This contract permits zero-copy paths without claiming every path is zero-copy.

Recording.fields exposes the actual captured rows and fields after binding, and Recording.axis names
the coordinate and optional unit. Output declarations in Document do not imply readable observations.
For sampled reads, omitted rows mean the physical-order intersection of selected fields' coverage;
explicit rows must be captured for every selected field. Each SampleColumn has its own strides, so
different field orientations need no shared-layout repacking. Coordinates are domain-neutral.

retain.bytes bounds observations and sample indexing for one recording. Complete frames are admitted
atomically. Rolling retention never renumbers logical frames. Shared pinned inputs and command
provenance use implementation-level budgets and must not be cloned/charged once per monitor.
Provenance cannot be silently evicted; exhaustion fails capture. Diagnostics use an optional bounded
ring with firstSequence and discardedThrough reporting. Without diagnostics retention, diagnostics() returns an empty page.
Consumer-held borrowed buffers can outlive retention and keep allocations alive: retain.bytes is
not a total process-memory guarantee.

## Runtime utilities and verification

Only five functions are exported at runtime:

```ts
validateSchema(candidate); // readonly Problem[]; no mutation
validateQuery(schema, candidateQuery); // schema must already be validated
validateBlock(schema, query, candidateBlock, queryOptions);
blockByteLength(block);
blockBuffers(block);
```

Validation is explicit boundary work, not a hidden scan on every local read. It checks declared
layouts, dictionaries, masks, coordinates, strides, selected fields, known index associations,
capabilities, and payload limits. It does not prove exclusive ownership, native referential integrity,
edit atomicity, whole-stream coverage, cancellation responsiveness, or solver isolation. Those are
implementation obligations exercised by behavioral tests.

The tests include deliberately narrow test implementations, not a production in-memory Model. They
exercise numeric filtering/sorting/pagination/aggregation, schema headers and empty reads, atomic
numeric edits, native assigned IDs, queued/running cancellation, command isolation, recording readiness,
sparse captured coverage, coordinate windows, retention, tiled coverage, pending reads, and ownership.
A native CSR fixture derives endpoint segments and missing/ambiguous links from its stored arrays.
Nested buffers and independent field strides have separate layout fixtures. Persistence tests exercise
shared acquisitions, incremental writes, interrupted commits, saved baselines and storage conflicts.
The separate @latkit/connect package tests remote behavior over message and framed transports. Allocation assertions
cover contiguous borrowed reads, sparse gathers, ownership copies, and backing/view accounting.

Run pnpm --filter @latkit/model-new build, typecheck, and test. No old package is needed by this one.

## Remaining cutover work

1. Implement a real model against this contract and run the same behavioral obligations against
   native editing, live routines, command cancellation during queued/running work, import diagnostics,
   and large segmented connectivity. Test fixtures cover their advertised narrow schemas; they are not a production query engine.
2. Integrate @latkit/connect with actual worker/socket deployment and application-owned Resource
   implementations. Supply authentication, authorization scopes, conditional storage commits and
   reconnection policy in that deployment; migrate consumers without a port compatibility facade.
3. Specify and implement a portable Recording archive with format versioning, bounds validation,
   indexed streaming reads, retained original inputs/schema, command provenance, and diagnostic gaps.
   Export currently identifies native formats by media type; it does not define an archive codec.
4. Move the GPU/playback query cache and index mapping into one shared consumption path. Reimplement
   network, diagram, monitor, and other consumers directly against Queryable and these columns.
   Application document history/layout/catalog state stays outside the contract.
5. Measure large real datasets across local, worker, socket, and archive paths: copied bytes,
   retained allocations, time to first block, cancellation latency, and GPU upload counts. Replace
   the old package only after those implementations demonstrate both correctness and the expected
   performance. Keep this candidate private until then.

## Large-data verification

The test-only paged ModelService in tests/scale runs million-row ownership, copy-on-write and command
isolation checks. Its independent oracle is also used across five connect paths. Run the separate
benchmark with pnpm --filter @latkit/connect bench:scale; methodology and scope are documented in
../connect/tests/scale/README.md. No scale fixture is exported by this package.
