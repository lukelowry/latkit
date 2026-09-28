# Document sessions

A format's synchronous `Document` remains the owner of native editing, validation, history, and
model creation. `Document.Session` is its asynchronous consumer contract. `@latkit/port` serves
that contract over a worker, a WebSocket, or any other `Port`.

## Open, edit, and close

```ts
import { connectDocument, serveDocument } from '@latkit/port';

// Worker or server: retain this Document instance for the workspace's lifetime.
const document = await model.document!();
const stopServing = serveDocument(serverPort, document);

// Browser: Remote<Document.Session>, including close().
const session = await connectDocument(clientPort);
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

const bytes = await session.bytes(); // Current native document, including placement.
const snapshot = await session.model();
try {
  const table = await snapshot.load('bus');
  inspect(table);
} finally {
  snapshot.close();
}

unsubscribe();
session.close();
stopServing();
```

`view` contains the version, schematic, palette, and public undo/redo metadata. Treat it and its
typed arrays as read-only. Vendor-specific inverse operations never cross the boundary.
`elementAt`, `partOf`, `portAt`, `portOf`, and `drivers` are synchronous local lookups.
They share `Document.parts(schematicOrGetter)` with the local document implementation.

One document service occupies a port. Engine services and scoped model services can share that
port. The same document can be served to multiple clients on separate ports.

## Ordering and conflicts

Every live document has one owner, one serialized queue, and a version:

```ts
{ epoch: 'owner-uuid', revision: 12 }
```

The epoch changes when the document owner is recreated. A successful change increments the
revision, including undo, redo, and layout changes. No-ops and refusals do not increment it.
History is shared by the document: undo reverses the latest document edit, regardless of which
client made it.

The facade captures an edit's base version and copies its operation arguments **at invocation**.
Await dependent edits. Two concurrent edits based on the same revision can conflict; the second
is never silently rebased onto potentially different element indexes. A UI retaining indexes in
an unsubmitted draft must refresh its selection after structural changes; the facade cannot infer
which past view an arbitrary caller-provided index came from.

A `DocumentConflict` includes `expected` and `actual` versions. The facade refreshes its view
before throwing it. A vendor refusal remains a `Refusal`, including `at` for highlighting.
An accepted edit resolves after the local view includes at least its accepted revision.

All edits and native reads must go through the served sessions while the document is served.
Synchronous external changes are observed, but an external writer bypasses the read/edit queue.

## Snapshots and performance

Model capture and native byte export run in the document's queue. Later queued edits cannot
change an in-progress capture. The resulting `Model` must satisfy the existing immutable model
contract, including its lazy class values and native bytes.

Models travel through the existing model service, with a separate service name per live
snapshot. Core packs load first, class shards load on demand, and an engine in the serving realm
can use the existing hosted-model token to run the original model in place.

Layout changes preserve the model and element indexing. Their view updates omit the netlist,
blocks, and nets. Other changes send only schematic fields whose values differ. Unchanged
columns retain their client-side identities. A changed column is currently sent in full; this
is not yet a sparse range-patch protocol. View buffers are copied, never transferred away from
the live document.

Repeated `model()` calls can return the same cached snapshot, including after layout edits.
Its close affects every reference to that cached snapshot; close it after all consumers and
recordings using it have finished. Different document model versions remain separately usable.
Closing or reconnecting the session releases all its remote snapshot services. Cancelling one
download does not cancel another reader's shared download; the last unclaimed reader releases
the unused service.

Slow peers with transport backpressure retain only their newest pending view event. A revision
gap makes the facade request a fresh view. Snapshot recovery emits a `change` with scope
`structure` and label `Refresh document`, because intermediate changes are no longer available.

The first implementation has explicit resource bounds:

| Resource                                         | Bound                                    |
| ------------------------------------------------ | ---------------------------------------- |
| Logical client identities per document           | 64; detached identities evicted first    |
| Receipt retention                                | Latest completed command per client      |
| Queued work per owner or client facade           | 256 calls                                |
| Queued encoded command payloads per owner        | 8 MiB                                    |
| One command                                      | 256 operations and 1 MiB encoded         |
| Live model snapshots per connection              | 32; close old snapshots to release slots |
| Pending outgoing view events per slow connection | 1                                        |

Overload rejects work before mutation. A `busy` edit reply does not consume its sequence;
a caller can retry after demand falls. The host must additionally bound the number of open
documents, workers, connections, and solver runs.

## Reconnect and recovery

```ts
// After transport loss, obtain a new port routed to the same retained Document.
await connectDocument(newPort, { resume: session });
// The same facade now has the current view and has reconciled its uncertain edit.
```

The facade keeps at most one edit whose acknowledgment is uncertain. Resuming replays the exact
client identity, sequence, base, and operations. The owner recognizes a duplicate before checking
the base revision and returns the original receipt. Reusing an identity with another payload is
rejected. A resumed client takes over its previous connection.

The facade serializes commands from one client, so retaining its latest receipt is sufficient
to recover a lost acknowledgment. Older sequences and evicted client identities fail explicitly.
They never restart as fresh commands. A new process or document owner also rejects the old
client identity. The application must resolve that recovery boundary before submitting new edits.

A failed edit call during disconnection does not establish whether the edit committed. Resume
the existing session to reconcile it. If the recovered command was refused or conflicted,
reconnect reports that outcome. A deliberately closed facade cannot be resumed.

Acknowledgments currently mean **accepted in memory**. They do not promise disk persistence or
recovery after a process restart. A page reload also loses the facade's in-memory pending command.
Aborting or disconnecting a request cannot reverse a mutation already accepted by the owner.

## Wire contract

This adds the `document` service to the existing Latkit protocol envelope. It does not change
the frame format or introduce another transport.

```json
{
  "svc": "document",
  "kind": "call",
  "id": 42,
  "body": {
    "op": "apply",
    "client": "client-uuid",
    "sequence": 7,
    "base": { "epoch": "owner-uuid", "revision": 12 },
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

The envelope's numeric `id` correlates one transport call. The pair `(client, sequence)` identifies
a logical edit across reconnects. These are separate identities.

| Request                                        | Reply                                  |
| ---------------------------------------------- | -------------------------------------- |
| `open { client? }`                             | `opened { client, next, view }`        |
| `view`                                         | `view { view }`                        |
| `apply { client, sequence, base, operations }` | Edit receipt                           |
| `undo / redo { client, sequence, base }`       | Edit receipt                           |
| `model { base }`                               | `model { version, id }` or conflict    |
| `bytes { base }`                               | `bytes { version, bytes }` or conflict |

Edit receipts are `accepted { version, change }`, `refused { message, at }`,
`conflict { version }`, `expired { message }`, or `busy { message }`.
Accepted, refused, and conflicting commands consume their sequence and retain their receipt.
No-op acceptance has `change: null`. Unexpected failures use the existing channel error envelope.

Events carry `update { from, to, change, schematic, palette?, history }`, where `schematic`
contains only replaced fields. Receipts do not duplicate those column payloads. The client
validates replies and events, ignores already-installed revisions, and resynchronizes on gaps.

Snapshot model services are named `model:<snapshot-uuid>`; standalone model services retain
the default `model` name. Both `serveModel` and `connectModel` accept an optional `id` to select
a scoped service. Existing model/engine APIs remain compatible.

On a worker/message port, the envelope uses structured clone. On a WebSocket or byte port, one
message is one binary frame:

```text
"LKPF" (4 bytes)
header length (little-endian uint32)
UTF-8 JSON: { body: envelope, arrays: [{ path, kind, bytes }] }
typed-array data, each section aligned to 8 bytes
```

Typed arrays stay binary, including NaN placement markers inside float arrays. JSON scalars follow
JSON rules; application edits reject nonfinite numeric scalars before sending. The frame has no
version byte or separate protocol version. Wire compatibility is defined by the Latkit package
version; peers must use compatible package releases. The service name is simply `document`.

## Scaling beyond one process

Retain one authoritative owner per document and distribute different documents across workers.
Route reconnects to the owning worker. Keep rendering, text drafts, and drag previews local, and
send completed transactions. Give editing and solver execution separate budgets.

For durable failover, use a transactional edit journal and checkpoints. Persist the accepted
command identity and result with the document change before acknowledging durable acceptance.
Recovery must restore history and the replay window together, or explicitly start a new epoch.
Use ownership leases with fencing so an old worker cannot continue committing after reassignment.

As cases grow, extend providers with cheap immutable snapshot capture and precise changed ranges.
That lets expensive model materialization leave the mutation queue and makes large position or
value updates proportional to the edit. Store immutable model/result shards by content hash and
serve bulk results on separately budgeted channels or sockets.

The current protocol uses optimistic concurrency and shared history. Simultaneous collaborative
editing would additionally need stable operation identities and defined merge/undo semantics.
Multiple backend replicas alone do not supply those semantics.
