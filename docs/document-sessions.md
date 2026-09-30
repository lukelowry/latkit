# Document sessions

A native `Document` owns current case state, editing, validation, history, and model creation. An
`Engine` holds the documents of the cases it keeps, one per case, and hands out
`Document.Session`s on them: the one way a host reads and edits a case, in the engine's realm or
across a port. A session across a port is a document service of its own on the engine's port, so
the case never leaves the realm that holds it, and every model a session captures is recorded
there by reference.

## Keep a vendor's cases

A vendor's engine takes the formats its cases are in and the store that keeps them. The store is
bytes by name, each read and written with a tag, so a write replaces only what the engine last read
or wrote; a directory, a bucket, and memory are each one.

```ts
import { Engine, type Document } from '@latkit/model';

class GridkitEngine extends Engine {
  constructor(cases: Engine.Cases, store: () => Series.Store) {
    super({ concurrency: 4, studies: STUDIES, store, formats: [gridkit], cases });
  }
  // parse and execute, as any engine
}

const engine = new GridkitEngine(directory('/workspace'), laneFiles('/runs'));
await engine.cases(); // [{ name: 'ieee39.case.json', format: 'gridkit', saved: null }, ...]
```

A `Document.Format` is how an engine opens and creates documents. Both `open(bytes)` and optional
`create(title)` return a document that needs no model and keeps nothing: the engine holds it and
keeps its bytes.

## Open, edit, save, and close

```ts
const session = await engine.open('ieee39.case.json');
const unsubscribe = session.on('change', (change) => {
  render(session.view.schematic, change.scope);
});

await session.apply({
  kind: 'set',
  element: { classId: 'bus', index: 0 },
  column: 'kv',
  value: 138,
});
await session.undo();
await session.redo();

const saved = await engine.save('ieee39.case.json', session.view.version);
const snapshot = await session.model();
try {
  const recording = engine.record(snapshot, input); // recorded where it lives
  await settled(recording);
} finally {
  snapshot.close();
}

unsubscribe();
session.close();
```

`engine.create(name, { title })` makes a new case in the format its name's extension names and keeps
it at once; `engine.create(name, { file })` does the same with the bytes of a file, such as one a
user picked. Both resolve with a session on the new case.

Across a port, the same calls reach the same engine:

```ts
import { connectEngine, serveEngine } from '@latkit/port';

// Where the cases and the solver are: one engine, served to every peer.
serveEngine(serverPort, engine);

// The page: an Engine whose cases are the peer's.
const remote = await connectEngine(clientPort);
const session = await remote.open('ieee39.case.json');
const model = await session.model();
const recording = remote.record(model, input); // the peer records its own model in place
```

`view` holds the version, the version its engine last kept (`saved`), the schematic, the palette,
and public undo and redo metadata; the case holds unsaved edits while `version` is past `saved`.
Treat it and its typed arrays as read-only. Vendor-specific inverse operations never cross the
boundary.
`elementAt`, `partOf`, `portAt`, `portOf`, and `drivers` are synchronous local lookups. They share
`Document.parts(schematicOrGetter)` with the native document.

## What the engine keeps open

Every session on a case shares the one document the engine holds for it: its history, its queue,
and its models. The engine opens a case on the first session and reads its bytes once. A document
with unsaved edits stays open whatever becomes of its sessions, until it is saved; a clean one no
session uses stays open while the idle cases' bytes fit the engine's budget (`idleBytes`, 256 MiB
unless its host says otherwise), the least recently opened let go first, so opening it again is
instant. `engine.cases()` reports, for each case it keeps, the version its open document last
saved; a document holds unsaved edits while its version is past that one.

`engine.save(name, version)` writes the document as it stands at `version`, in the document's queue,
so the bytes are exactly that version's, and every session on the case hears it: its view's `saved`
becomes `version`, and its `saved` listeners are told, whichever session saved and wherever each
is. It refuses a version the document has moved past with
`DocumentConflict`, and a case its store no longer holds as the engine last read or wrote it with
the store's own error: the case changed outside the engine, and nothing is overwritten.

`engine.close()` closes every session on its cases, stops every recording it may still grow, and
resolves once its work has ended.

## Inspect and edit a retained draft

```ts
const { version, inspection } = await session.inspect('bus/12', signal);
if (inspection !== null) {
  // Keep the version with the form while the user edits its values.
  const value = await editVoltage(inspection.values.kv);
  await session.apply(version, {
    kind: 'set',
    element: inspection.element,
    column: 'kv',
    value,
  });
}
```

`inspect(elementOrKey, signal?)` returns `{ version, inspection }`. The document resolves keys and
reads values and wiring together in its queue, against the view's revision at invocation. A stale
read rejects with `DocumentConflict`; a missing element returns `inspection: null`. An existing
element may have `key: null` when its format supplies no persistent identity. Results remain
independent of later edits, including undo and redo.

`Document.Inspection` contains the element and key, editable `values` keyed by the column names
accepted by `set`, declared `ports` with their connected net or null, and a net's `members` with
owner references and port names. Wiring includes elements absent from the diagram. These values
belong to the native document and need not be displayed model columns.

Native subclasses implement synchronous `inspect(element)` using their native indexes, returning
null only for a missing element. Inspection must not mutate the document or open a model. Results
in the engine's realm may borrow indexed data, which callers treat as read-only; across a port only
public fields cross, validated and bounded, as detached data.

Use `apply(version, ...operations)` to submit a retained draft. The document checks that exact base,
including changes that arrived while the user edited the form, and a conflict never silently
rebases indexes or overwrites newer values. Ordinary `apply(...operations)` takes the view's version
at invocation. Even a layout change makes an older draft stale.

## Ordering and conflicts

Every document has one queue, and a version, the document's own `document.version`:

```ts
{ epoch: 'document-uuid', revision: 12 }
```

The epoch is new with each document, so a document opened again starts a new one. A successful
change increments the revision, including undo, redo, and layout changes. No-ops and refusals do
not increment it. History is shared by the document: undo reverses the latest document edit,
regardless of which session made it.

A session takes an edit's explicit base, or the view's version, together with its operation
arguments **at invocation**, and every call waits its turn in the document's queue. Await dependent
edits and reads: a call made before an earlier edit lands still names the revision before it, and
rejects with `DocumentConflict` rather than acting on indexes that may have moved. The view refreshes
before the conflict is thrown. A vendor refusal remains a `Refusal`, including `at` for highlighting.
An accepted edit resolves after the view includes at least its accepted revision.

An edit names its base revision, so it applies at most once: sent again after it landed, it names a
revision gone by and conflicts. A session whose connection failed with an edit in flight cannot
know whether the edit landed; open the case again and read the view, which is the truth.
Acknowledgments mean **accepted in memory**; `engine.save` is what makes a version durable.

All edits and reads of a document an engine holds go through its sessions. A host that edits the
native document directly bypasses the queue.

## Snapshots and performance

Model capture and native byte export run in the document's queue. Later queued edits cannot change
an in-progress capture. The resulting `Model` must satisfy the immutable model contract, including
its lazy class values and native bytes. Its first capture is lazy too; opening a session does not
build a model. If opening a model fails, the call rejects and the next capture retries without an
intervening edit or reconnect. A superseded capture's failure cannot invalidate a newer capture.

Across a port, a model crosses as a model service of its own, `model:<snapshot-uuid>`: its core
first, class shards on demand. The engine beside the document records it where it lives, from the
token the served model carries, so no case bytes move to record it. Close a model once its readers
and recordings finish; closing the session closes every model it captured.

Layout changes preserve the model and element indexing. Their view updates omit the netlist,
blocks, and nets. Other changes send only schematic fields whose values differ, compared by
identity. Unchanged columns retain their client-side identities. A changed column is sent in full.
View buffers are copied, never transferred away from the live document.

Repeated `model()` calls can return the same cached snapshot, including after layout edits. Its
close affects every reference to that snapshot; close it after all consumers and recordings using it
have finished. Different document model versions remain separately usable. Cancelling one download
does not cancel another reader's shared download; the last unclaimed reader releases the unused
service.

Slow peers with transport backpressure retain only their newest pending view update. A revision gap
makes the session request a fresh view, and the view's refresh emits a `change` with scope
`structure` and label `Refresh document`, because intermediate changes are no longer available.

| Resource                                       | Bound                                      |
| ---------------------------------------------- | ------------------------------------------ |
| Calls waiting on one document                  | 256; more are refused until it drains      |
| One edit                                       | 256 operations                             |
| One inspection payload                         | 1 MiB encoded; 4,096 values and ports each |
| Live model snapshots per session across a port | 32; close old snapshots to release slots   |
| Pending outgoing view updates per slow session | 1                                          |
| Clean cases kept open for no session           | `idleBytes` of their bytes, 256 MiB        |

Oversized inspections reject explicitly and never silently truncate values or wiring. Members also
share the one-million-element bound used by schematic arrays.

## Wire contract

Each session across a port is its own service, `document:<session-id>`, on the engine's port. The
engine's `engine:cases` service lists cases, opens and creates them, answering with the session's
id, and saves them. Neither changes the frame format or adds a transport.

```json
{
  "svc": "document:6f0c…",
  "kind": "call",
  "id": 42,
  "body": {
    "op": "apply",
    "base": { "epoch": "document-uuid", "revision": 12 },
    "operations": [
      {
        "kind": "set",
        "element": { "classId": "bus", "index": 0 },
        "column": "kv",
        "value": 138
      }
    ]
  }
}
```

| Request                          | Reply                                |
| -------------------------------- | ------------------------------------ |
| `open`                           | `opened { view }`                    |
| `view`                           | `view { view }`                      |
| `inspect { base, target }`       | `inspection { version, inspection }` |
| `apply { base, operations }`     | Edit receipt                         |
| `undo { base }`, `redo { base }` | Edit receipt                         |
| `model { base }`                 | `model { version, id }`              |
| `bytes { base }`                 | `bytes { version, bytes }`           |

Edit receipts are `accepted { version, change }` or `refused { message, at }`; any request made
against a revision gone by is answered `conflict { version }`. No-op acceptance has `change: null`.
Unexpected failures use the channel's error envelope.

Events carry `saved { version }` when the engine keeps a version of the case, and
`update { from, to, change, schematic, palette?, history }`, where `schematic` contains
only replaced fields. Receipts do not duplicate those column payloads. The session validates
replies and events, ignores already-installed revisions, and refreshes on gaps.

On a worker or message port, the envelope uses structured clone. On a WebSocket or byte port, one
message is one binary frame:

```text
"LKPF" (4 bytes)
header length (little-endian uint32)
UTF-8 JSON: { body: envelope, arrays: [{ path, kind, bytes }] }
typed-array data, each section aligned to 8 bytes
```

Typed arrays stay binary, including NaN placement markers inside float arrays. JSON scalars follow
JSON rules; sessions reject nonfinite numeric scalars before sending. The frame has no version byte
or separate protocol version. Wire compatibility is defined by the Latkit package version; peers
must use compatible package releases.

## Scaling beyond one process

One engine process holds a case's one document, and every session on the case reaches it through
that engine's port, so a host routes a case's peers to the engine that keeps it. Distribute
different cases across engines, give editing and solver execution separate budgets, and keep
rendering, text drafts, and drag previews local, sending completed transactions.

For durable failover, persist accepted edits with the document change in a transactional journal
before acknowledging them, and recover history together with it or start a new epoch. As cases
grow, cheap immutable snapshot capture and precise changed ranges let model materialization leave
the queue and make large position or value updates proportional to the edit.
