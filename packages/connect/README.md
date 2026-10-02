# @latkit/connect

Two endpoints for demand-driven model connections:

- `connectLattice(options)` registers a producer and serves requested observations and commands.
- `acceptModel(socket, options?)` accepts that producer on a host.

Registration sends schema and command descriptions only. Nothing reads or sends model values until
the host requests them. There is no snapshot callback, global publisher, transaction event stream,
or automatic history cache.

## Producer

This complete producer exposes a small model and a typed command. The same API works with a solver
that generates bounded batches directly.

```ts
import { connectLattice } from '@latkit/connect';
import { createData, selectBatches } from '@latkit/model';

const schema = {
  types: { Bus: { fields: { load: { type: 'float64' } } } },
} as const;

function values(multiplier: number) {
  return createData(schema, String(multiplier), [
    {
      kind: 'rows',
      index: { source: 'grid', type: 'Bus', version: 'rows-1' },
      rows: { kind: 'range', offset: 0, count: 3 },
      columns: {
        load: {
          kind: 'numeric',
          offset: 0,
          length: 3,
          values: Float64Array.of(2, 4, 6).map((value) => value * multiplier),
        },
      },
    },
  ]);
}
let current = values(1);

const connection = await connectLattice({
  url: 'http://localhost:3000',
  name: 'grid',
  schema,
  monitor(fields, { signal, maxBatchBytes }) {
    return selectBatches(current, fields, { signal, maxBlockBytes: maxBatchBytes });
  },
  commands: {
    scale: {
      parameters: { multiplier: { type: 'number', min: 0, default: 1 } },
      async run({ multiplier }, { signal, outputs, publish, progress, log, maxBatchBytes }) {
        // multiplier is inferred as number.
        const next = values(multiplier);
        for await (const batch of selectBatches(next, outputs, {
          signal,
          maxBlockBytes: maxBatchBytes,
        }))
          await publish(batch);
        current = next;
        progress({ completed: 1, total: 1 });
        log({ severity: 'info', message: 'Scale applied.' });
        return { multiplier };
      },
    },
  },
});

await connection.closed;
```

The URL is the host base URL. HTTP(S) becomes WS(S), and
`/models/${encodeURIComponent(name)}` is appended to its path. Authentication, retries, registry
naming, and application scheduling belong to the host/application.

A monitor may yield one `DataBatch` or a bounded array of batches. It may be finite or live.
`selectBatches` reads a captured local `Data` value; it does not subscribe to changes.
Implement a live iterable if the application needs continuous observation.

## Host

Accept sockets immediately in the WebSocket connection handler, so registration cannot be missed.
For example, using `ws` (an application dependency):

```ts
import { WebSocketServer } from 'ws';
import { acceptModel } from '@latkit/connect';

const server = new WebSocketServer({
  port: 3000,
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
  handleProtocols: (protocols) => (protocols.has('latkit') ? 'latkit' : false),
});

server.on('connection', (socket) => {
  void serve(socket).catch(console.error);
});

async function serve(socket: import('ws').WebSocket) {
  const model = await acceptModel(socket);
  try {
    const fields = [{ from: 'Bus', select: ['load'] }];
    for await (const publication of model.monitor(fields)) {
      console.log(publication); // readonly DataBatch[]
    }

    const result = await model.run(
      'scale',
      { multiplier: 2 },
      {
        outputs: fields,
        async onData(publication) {
          await storePublication(publication);
        },
        onProgress: (progress) => console.log(progress),
        onLog: (diagnostic) => console.log(diagnostic),
      },
    );
    console.log(result);
  } finally {
    await model.close();
  }
}

// Replace with application storage. Await its actual bounded write.
async function storePublication(publication: readonly import('@latkit/model').DataBatch[]) {
  console.log(publication);
}
```

A connected model has `name`, `schema`, `commands`, `monitor`, `run`, `close`, and `closed`.
Command metadata uses `CommandDescription` and `Parameter` from `@latkit/model`. IDs, credits,
wire opcodes, and execution bookkeeping stay inside the connection.

## Delivery and ownership

Each publication is one atomic bounded message. Large models use many publications; atomicity does
not extend across an entire model or execution. Applications needing a complete replacement can
stage a bounded or persisted stream and expose it when the monitor ends or the command succeeds.
Earlier publications remain valid if a later publication fails. Static replacement and retained
history policies belong to the application.

Always await `publish` before reusing its arrays or publishing again. It resolves when the encoded
copy is safe to reuse and local capacity is available, without waiting for a remote round trip for
each batch. An iterable may reuse its yielded arrays after its next pull. A command's outstanding
publish is awaited even if the handler forgets to await it; overlapping publishes fail.

The receiver returns credit when the iterator asks for its next publication or an `onData`
callback completes. Returned arrays are stable, immutable application-owned values; credit release
does not invalidate them. Retaining them consumes application memory, outside connection budgets.
Decoded numeric columns view received storage on little-endian systems. Encoding performs one
outgoing payload copy; native WebSocket implementations may make additional copies.

Requested command outputs require `onData`. A result resolves only after preceding data callbacks
complete. Field demand is checked on both ends. The producer must honor row selections and their
domain IDs; the connection does not retain an ID-to-row cache.

`progress` coalesces pending updates. `log` keeps a bounded ring and reports dropped entries
explicitly. Messages are truncated to fit metadata limits. Progress/log callbacks are synchronous;
use `onData` for awaited work.

## Encoded forwarding

A host can retain or forward the publication payload without re-encoding columns:

```ts
for await (const publication of model.monitor(fields, { format: 'encoded', signal })) {
  await writeToBoundedStore(publication.bytes);
}
await model.run('solve', values, {
  outputs: fields,
  format: 'encoded',
  onData: (publication) => writeToBoundedStore(publication.bytes),
});
```

`@latkit/connect/protocol` provides `decodePublication`, `preparePublication`, and the explicit
wire codec for implementations and gateways. The primary API uses model types and WebSocket
interfaces; renderers consume `Data`, independent of this protocol. Encoded mode still validates
incoming layouts at the trust boundary. Payloads omit connection-local IDs and sequences.

Lattice must choose fan-out policy itself: awaiting every page lets the slowest page throttle the
producer. Use bounded per-page queues with an explicit disconnect/drop policy, or bounded durable
storage. The SDK does not silently retain snapshots or replay a running execution.

## Limits and lifecycle

Both endpoints negotiate the minimum of their limits:

| Limit                                                      |                 Default |
| ---------------------------------------------------------- | ----------------------: |
| Complete message                                           |                   1 MiB |
| JSON metadata                                              |                  64 KiB |
| Total reserved receive windows                             | 16 MiB / 1,024 messages |
| Each stream window                                         |    4 MiB / 256 messages |
| Stream descriptors                                         |                      32 |
| Batches per publication                                    |                      64 |
| Pending diagnostics per execution                          |                      32 |
| Registration, blocked send, cancellation, cleanup deadline |              30 seconds |

The global window budget can admit fewer streams than the descriptor ceiling (four full default
windows). New streams fail immediately when reservations are exhausted. Control sends have a
separate 16 MiB byte budget and at most `maxStreams + 8` queued sends. The native send buffer is
also capped at `maxBufferedBytes` before each send. There is one pending publication per active
producer stream; it may borrow caller storage until encoding. Sender acknowledgement ledgers
retain byte counts, not payload history. Metadata has a depth limit of 24 and a traversal limit of
8,192 nodes.

Thus connection-owned live queues are bounded independently of total rows, frames, and elapsed
stream duration. These bounds are not a process RSS cap: JavaScript object overhead, GC timing,
caller-owned arrays/history, file copies, and OS/native WebSocket buffers also use memory. Configure
the host WebSocket's inbound message limit as above; browser/native WebSocket may allocate a peer
message before this package receives and rejects it.

Use an `AbortSignal` for a connection, monitor, or run. Returning/breaking a monitor cancels it,
including a pending pull. One command executes per producer, independently of monitors. Cancellation
stops consumer waits promptly; producer code must observe its signal and release its resources.
A noncooperating producer triggers cancellation/cleanup deadlines, and a command slot remains busy
until its handler exits. There is no forced termination of arbitrary application code.

An idle completed stream retains its bounded reservation until consumed or cancelled. A producer
blocked on exhausted credit fails that stream after the deadline. Remote closure, protocol faults,
and cleanup failures reject `closed`; a successful local close resolves it. Reconnect explicitly;
commands are not replayed, retried, or claimed to execute exactly once across failures.

## Code layout and verification

- `types.ts`: public API and limits.
- `connect.ts` / `accept.ts`: producer and host behavior.
- `session.ts`: routing, credit windows, bounded queues, cancellation.
- `socket.ts`: WebSocket events and native send-buffer limits.
- `frame.ts` / `columns.ts`: framing and model column encoding.
- `parameters.ts` / `core.ts`: boundary validation and small shared primitives.

Run `pnpm --filter @latkit/connect test` and `pnpm --filter @latkit/connect bench:scale`.
The tests cover real native-WebSocket-to-ws connections, demand-only delivery, command/file
validation, delayed callbacks, cancellation, disconnects, encoded ownership, all column layouts,
credit exhaustion, admission limits, malformed frames, and control ordering.

The benchmark transfers 128 MiB each of static rows and sampled values through both endpoints.
Its assertions verify values and a maximum lead of 16 publications for 256 KiB payloads under a
4 MiB window. It also checks that decoding 256 MiB uses received typed-array storage. Throughput
depends on the machine, network, validation cost, and consumer speed; measurements are not a
universal latency/throughput guarantee or a claim to outperform every earlier client.

This is a breaking replacement. There are no `connect`/`serve`, MessagePort adapters, polling
models, snapshot callbacks, or compatibility wrappers. See [PROTOCOL.md](PROTOCOL.md).
