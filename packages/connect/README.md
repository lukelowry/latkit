# @latkit/connect

Remote access to the @latkit/model contract. Five runtime exports from one root:
connect, serve, messagePort, webSocket and byteTransport. No compatibility layer, model
re-exports, transport-shaped model objects, domain cache or data conversion facade.

## Public surface

| Export                                     | Purpose                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| connect(transport, options?)               | Establish a Connection: the remote Model itself                             |
| serve(transport, model, options?)          | Serve one connection against an application-authorized Model                |
| messagePort(target)                        | Dedicated MessagePort, Worker or worker-scope messages with buffer transfer |
| webSocket(socket, limits?)                 | Ordered binary WebSocket frames and bounded send buffering                  |
| byteTransport(channel, limits?)            | The same binary framing over a custom message-oriented ByteChannel          |
| Connection                                 | Model plus close() and closed                                               |
| QueryableConnection                        | Queryable plus closed; close releases the connection                        |
| QueryableConnectOptions                    | Explicit kind: queryable capability plus cancellation and limits            |
| Transport                                  | Ordered reliable send/subscribe/close with declared transfer support        |
| ByteChannel                                | Ordered complete binary messages with send/subscribe/close                  |
| ConnectOptions / ConnectionLimits          | Cancellation and negotiated resource bounds                                 |
| MessageTarget / SocketTarget / FrameLimits | Structural adapter inputs and frame bounds                                  |

The host supplies a transport and gets the same interfaces used locally. The serving application
supplies a native Model or an explicit Queryable capability; connect does not implement domain
data, routines or storage. Serve a model the application has already authorized: authentication,
access policy, process launch and reconnect decisions belong to the deployment.

## Worker and host

```ts
// Worker entry: model implements Model using native domain behavior.
import { serve, messagePort } from '@latkit/connect';
import { model } from './implementation.js';

await serve(messagePort(self), model);
```

```ts
import { connect, messagePort } from '@latkit/connect';

async function useWorker(worker: Worker) {
  const model = await connect(messagePort(worker));
  try {
    const voltages = await model.monitor([{ from: 'Bus', select: ['Vm'] }]);
    await model.run({ routine: 'solve', values: {} });
    for await (const block of voltages.query({
      kind: 'samples',
      from: 'Bus',
      select: ['Vm'],
      window: { kind: 'frames', offset: 0, count: voltages.frames },
    })) {
      if (block.kind !== 'schema') console.log(block.coordinates, block.columns.Vm);
    }
  } finally {
    await model.close(); // Ends this connection, its monitors, reads and commands.
  }
}
```

The serving application can call serve repeatedly against the same model for separate clients.
Every client shares that model: each monitor streams every command, whoever ran it. A client's
monitors, retained reads and commands belong to its connection. Closing or losing the connection
cancels its commands, queued or running, and releases its monitors and reads; it never closes the
shared model, which its owner closes. Message adapter close detaches its listeners and closes a
MessagePort if supported; it does not terminate a Worker owned by the host. Use dedicated message
targets. Worker termination is not universally observable through the browser Worker API; the host
must close/abort its Connection when it terminates the worker.

Every method of a kind crosses, and none is optional: a model has describe, query, retain, close,
monitor and run; a monitor has describe, query, retain, close and export. A model that computes
nothing has no routines. Model state (name, version, routines) and monitor state (status, frames,
range, progress, diagnostics) arrive before the change event that announces them.

## Read-only consumers

A consumer that only needs data connects to a Queryable capability. The mode is explicit on both
sides; mismatched capabilities reject unsupported. This exposes only version, describe, query,
retain, change events and close, even when the native object is a Model or a monitor. No commands,
monitors or exports cross this boundary.

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

serve borrows the root; it never closes the supplied object. Closing the root in its owner ends its
connections and releases each peer's acquired children. A directly supplied live Queryable can
publish changes; use retain first when the consumer requires fixed data. Remote retain calls acquire
explicit owned references, without serializing functions or collecting query results. Closing a
parent monitor or retained acquisition leaves independently acquired children usable on the same
connection. Closing the connection releases all acquisitions belonging to it.

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
This is a connection protocol, not a recording archive format. Direct message transport is for trusted
local structured-clone peers; socket framing validates lengths, metadata, typed views and nesting
before constructing canonical blocks. Application authorization is still required where the model
is served.

## Streaming, cancellation and memory

Default limits per peer are 1 MiB metadata per message, 16 MiB connection bytes in flight, 128 active
streams and 2048 references. The smaller peer limits win. Active calls are bounded by maxReferences.
Frame limits may further restrict a byte adapter. Schema headers count against metadata bounds;
query payload bounds remain separate from wire framing and allocated backing size.

Streams are pull-driven with one outstanding request per iterator, per-pull byte credit and a shared
connection budget. There is no eager data collection or unbounded receive queue. Different streams
share the budget. Slow unsolicited events fail the connection on queue exhaustion rather than
silently dropping updates, so implementations should coalesce appends rather than announce every
frame on its own. Consumer-held buffers and native model working memory are outside this transport
budget; implementations and applications must bound their own retention.

Query headers and blocks retain the canonical model format. Message transports request owned native
blocks and transfer their backing allocations. Other borrowed bytes are compacted before transfer,
so a caller's input chunks are never detached. Socket encoding copies into a frame; received typed
views address that frame directly. Tight owned-block limits can require compaction on receipt.
No universal zero-copy promise is made.

Query iterator return/throw/AbortSignal cancels a pending pull and releases its remote iterator.
Content input and export stream cancellation propagates in both directions. A command whose inputs
cannot be sent releases those already sent, without locking the caller's streams. Native
implementations must honor their cancellation and close contracts. Failure code, message, target and
issues survive transport; stack traces and custom prototypes do not. Connection.closed resolves for
graceful close and rejects for unexpected transport failure. Local close does not wait for a blocked
socket to drain; the remote may observe transport loss when the final close message cannot be
accepted immediately.

Cancellation requests interruption, not rollback. A disconnected command may already have run.
There are no automatic retries, deduplication guesses or implicit reconnection, and nothing can be
reacquired by id afterwards: a client reconnects and opens new monitors.

## Verification and integration

Tests exercise direct messages and binary framing, one model shared across clients, monitors that
start over for each command, commands that run one at a time, queued and running cancellation,
content inputs and exports under tight budgets, owned buffers, retained coverage and lifetime,
read-only capability allowlists, repeated acquire/release, bounded streams, and disconnect cleanup.
Socket adapter tests exercise ordering, backpressure, close and the full protocol using an in-process
socket pair. Actual deployment sockets, browser workers and production storage require integration
tests in their owning applications.

Run pnpm --filter @latkit/connect build, typecheck and test. @latkit/model is its only runtime
dependency. Consumers migrate to this contract directly rather than through a compatibility layer.

## Scale benchmark

Run pnpm --filter @latkit/connect bench:scale for independently verified 100K, 1M and 4M-row workloads.
The harness covers local calls, message and framed transports, a real Node worker, and loopback TCP.
It reports timings, payload-copy counters and sampled memory to output/model-connect-performance.json.
See tests/scale/README.md for methodology, repeat settings, deterministic assertions and remaining
coverage. Ordinary tests enforce correctness and bounds without machine-dependent speed thresholds.
