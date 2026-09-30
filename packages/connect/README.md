# @latkit/connect

Remote access to the @latkit/model contract. Five runtime exports from one root:
connect, serve, messagePort, webSocket and byteTransport. No port compatibility layer, model
re-exports, transport-shaped document objects, domain cache or data conversion facade.

## Public surface

| Export                                     | Purpose                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| connect(transport, options?)               | Establish a Connection implementing ModelService                            |
| serve(transport, service, options?)        | Serve one connection against an application-authorized ModelService         |
| messagePort(target)                        | Dedicated MessagePort, Worker or worker-scope messages with buffer transfer |
| webSocket(socket, limits?)                 | Ordered binary WebSocket frames and bounded send buffering                  |
| byteTransport(channel, limits?)            | The same binary framing over a custom message-oriented ByteChannel          |
| Connection                                 | ModelService plus close() and closed                                        |
| QueryableConnection                        | Queryable plus closed; close releases the connection                        |
| QueryableConnectOptions                    | Explicit kind: queryable capability plus cancellation and limits            |
| Transport                                  | Ordered reliable send/subscribe/close with declared transfer support        |
| ByteChannel                                | Ordered complete binary messages with send/subscribe/close                  |
| ConnectOptions / ConnectionLimits          | Cancellation and negotiated resource bounds                                 |
| MessageTarget / SocketTarget / FrameLimits | Structural adapter inputs and frame bounds                                  |

The host supplies a transport and gets the same interfaces used locally. The serving application
supplies a native ModelService or an explicit Queryable capability; connect does not implement domain editing, routines or storage.
Use a service scoped to the authenticated application's authority. Authentication, document catalogs,
access policy, process launch and reconnect decisions belong to the deployment.

## Worker and host

```ts
// Worker entry: service implements ModelService using native domain behavior.
import { serve, messagePort } from '@latkit/connect';
import { service } from './implementation.js';

await serve(messagePort(self), service);
```

```ts
import { connect, messagePort } from '@latkit/connect';
import type { Resource } from '@latkit/model';

async function useWorker(worker: Worker, resource: Resource) {
  const remote = await connect(messagePort(worker));
  try {
    // Resource methods execute on this host when the worker needs bytes or publishes a save.
    const document = await remote.open({ kind: 'resource', resource });
    const model = await remote.model(document.id);
    try {
      for await (const block of document.query({
        kind: 'rows',
        from: 'Node',
        select: ['value'],
      })) {
        if (block.kind !== 'schema') console.log(block.columns.value);
      }
      if (document.save) await document.save();
      await model.reset(); // Shared document inputs are preserved.
    } finally {
      await model.close();
      await document.close();
    }
  } finally {
    await remote.close();
  }
}
```

Resource is a revocable grant to one stored object. Its host implements tagged reads and atomic
conditional writes. The receiving Document retains it while needed; failed setup closes it. Each
lending uses a distinct grant. Connection loss revokes grants lent through that connection, while
other clients' acquisitions of the shared Document remain valid. An authorized replacement client
can acquire document(id) and attach a fresh grant for the same resource ID. This does not overwrite
shared edits or advance the saved storage baseline.

The serving application can call serve repeatedly against the same service for separate clients.
Closing one Connection releases that peer's acquisitions and grants; it never closes the shared
ModelService. Message adapter close detaches its listeners and closes a MessagePort if supported;
it does not terminate a Worker owned by the host. Use dedicated message targets. Worker termination
is not universally observable through the browser Worker API; the host must close/abort its
Connection when it terminates the worker.

## Read-only consumers

A consumer that only needs data connects to a Queryable capability. The mode is explicit on both
sides; mismatched capabilities reject unsupported. This exposes only version, describe, query,
retain, change events and close, even when the native object is a Document or Recording.
No mutation, command, capture-control or storage methods cross this boundary.

```ts
// Host: fix the data needed by this consumer, then lend that acquisition.
const source = await recording.retain({
  window: { kind: 'range', between: [100, 200], context: { before: 1, after: 1 } },
  maxBytes: 512 * 1024 * 1024,
});
try {
  await serve(workerTransport, source, { kind: 'queryable', signal });
} finally {
  await source.close();
}
```

```ts
// Consumer: use the same query vocabulary as local code.
const source = await connect(hostTransport, { kind: 'queryable', signal });
try {
  for await (const block of source.query({
    kind: 'samples',
    from: 'Node',
    select: ['output'],
    window: { kind: 'range', between: [100, 200] },
  })) {
    if (block.kind !== 'schema') console.log(block.coordinates, block.columns.output);
  }
} finally {
  await source.close();
}
```

serve borrows the root; it never closes the supplied acquisition. Closing the root in its owner
ends its connection and releases that peer's acquired children. A directly supplied live Queryable
can publish changes; use retain first when the consumer requires fixed data. Remote retain calls
acquire explicit owned references, without serializing functions or collecting query results.
Closing a parent Document, Recording or retained acquisition leaves independently acquired children
usable on the same connection. Closing the connection releases all acquisitions belonging to it.

## File-free and live use

```ts
const document = await remote.open();
const model = await remote.model(document.id);
if (model.monitor) {
  const recording = await model.monitor({
    scope: { kind: 'live' },
    fields: [{ from: 'Node', select: ['output'] }],
    retain: { kind: 'rolling', frames: 1000, bytes: 8 * 1024 * 1024, onLimit: 'fail' },
  });
  await recording.ready;
  // Read live observations through recording.query(...); commands remain separate.
  await recording.stop();
  await recording.close();
}
await model.close();
await document.close();
```

A service may have no formats. Optional edit/save/parse/call/monitor methods remain absent remotely
when absent locally. A live co-simulation peer uses ordinary live routines and monitoring, and can
reject additional Model acquisitions with busy when exclusive access is required. connect does not
impose a solver, clock, file lifecycle or isolated execution model.

## Sockets and custom channels

```ts
import { connect, webSocket } from '@latkit/connect';

const remote = await connect(webSocket(new WebSocket(url)), {
  signal: lifetime.signal,
  limits: { maxInFlightBytes: 8 * 1024 * 1024, maxStreams: 32 },
});
```

webSocket waits for opening, keeps ordered sends under backpressure, bounds queued bytes, and rejects
pending sends on close. Binary frames contain bounded UTF-8 metadata plus aligned typed-array bytes.
Numeric payloads never become JSON arrays. ByteChannel must provide complete, ordered binary messages;
a raw TCP stream needs message framing supplied by its channel. Transport.close() must terminate
pending I/O. Custom transports are responsible for bounding allocations before handing messages to
connect; the built-in byte decoder tightens its limits when connection bounds are negotiated.

Wire protocol version 2 is internal to this candidate package. Unsupported versions fail explicitly.
This is a connection protocol, not a Recording archive format. Direct message transport is for trusted
local structured-clone peers; socket framing validates lengths, metadata, typed views and nesting
before constructing canonical blocks. Application authorization is still required at the service.

## Streaming, cancellation and memory

Default limits per peer are 1 MiB metadata per message, 16 MiB connection bytes in flight, 128 active
streams and 2048 references. The smaller peer limits win. Active calls are bounded by maxReferences.
Frame limits may further restrict a byte adapter. Schema headers count against metadata bounds;
query payload bounds remain separate from wire framing and allocated backing size.

Streams are pull-driven with one outstanding request per iterator, per-pull byte credit and a shared
connection budget. There is no eager data collection or unbounded receive queue. Different streams
share the budget. Slow unsolicited events fail the connection on queue exhaustion rather than
silently dropping updates. Consumer-held buffers and native model working memory are outside this
transport budget; implementations and applications must bound their own retention.

Query headers and blocks retain the canonical model format. Message transports request owned native
blocks and transfer their backing allocations. Other borrowed bytes are compacted before transfer,
so a caller's input chunks are never detached. Socket encoding copies into a frame; received typed
views address that frame directly. Tight owned-block limits can require compaction on receipt.
No universal zero-copy promise is made. Storage copy parts travel as ranges rather than file bytes.

Query iterator return/throw/AbortSignal cancels a pending pull and releases its remote iterator.
Content and export stream cancellation propagates in both directions. Native implementations must
honor their cancellation and close contracts. Input preflight validation uses temporary non-consuming
grants and cannot lock or read the caller's content stream. Closing/resetting a Model finishes capture
without disposing independently acquired Recordings or Queryables. remote.recording(id) acquires a
separate authorized handle, including across connections while the native Recording remains retained.
Closing a Document acquisition leaves other acquisitions intact. Connection loss releases only that
peer's references; other clients' Recording acquisitions and retained data remain usable.

Metadata updates arrive before event listeners run. Recording readiness and completion are delivered
even when they precede the monitor reply. Failure code, message, target and issues survive transport;
stack traces and custom prototypes do not. Connection.closed resolves for graceful close and rejects
for unexpected transport failure. Local close does not wait for a blocked socket to drain; the remote
may observe transport loss when the final close message cannot be accepted immediately.

Cancellation requests interruption, not rollback. A disconnected command, edit or conditional write
may already have committed. There are no automatic retries, deduplication guesses or implicit
reconnection. Applications explicitly acquire references and re-lend resources after reconnecting.

## Verification and integration

Tests exercise direct messages and binary framing, shared documents across clients, independent
Models, resource range reads and incremental writes, live-only exclusive peers, capture readiness,
owned buffers, retained coverage and lifetime, read-only capability allowlists, repeated acquire/release,
bounded streams, cancellation and disconnect cleanup.
Socket adapter tests exercise ordering, backpressure, close and the full service protocol using an
in-process socket pair. Actual deployment sockets, browser workers and production storage require
integration tests in their owning applications.

Run pnpm --filter @latkit/connect build, typecheck and test. @latkit/model is its only runtime
dependency. The old @latkit/port and its consumers remain unchanged; migration should consume this
contract directly rather than add a compatibility layer.

## Scale benchmark

Run pnpm --filter @latkit/connect bench:scale for independently verified 100K, 1M and 4M-row workloads.
The harness covers local calls, message and framed transports, a real Node worker, and loopback TCP.
It reports timings, payload-copy counters and sampled memory to output/model-connect-performance.json.
See tests/scale/README.md for methodology, repeat settings, deterministic assertions and remaining
coverage. Ordinary tests enforce correctness and bounds without machine-dependent speed thresholds.
