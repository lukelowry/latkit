# @latkit/connect

Carries a model across a WebSocket. A model is a value (`Model` from `@latkit/model`): a name, a
schema, an optional `monitor` that reads fields, and commands. One side offers it, the other accepts
it, and either side may dial:

- `connectModel(model, { url } | { socket })` offers `model`.
- `acceptModel({ url } | { socket })` accepts the model the other side offers, as a `ConnectedModel`.

`url` is dialed exactly as given; `socket` is one a server already accepted. Registration sends the
schema and command descriptions only. Nothing reads or sends model values until the accepting side
asks for them. There is no snapshot callback, global publisher, transaction event stream, or
automatic history cache.

## A model

This complete model has a small data set and a typed command. The same shape works for a simulation
that generates bounded batches directly.

```ts
import { connectModel } from '@latkit/connect';
import { createData, selectBatches } from '@latkit/model';

const schema = {
  types: { Bus: { fields: { load: { type: 'float64' } } } },
} as const;

function values(multiplier: number) {
  return createData(schema, [
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

const connection = await connectModel(
  {
    name: 'grid',
    schema,
    monitor: (fields, { signal, maxBlockBytes }) =>
      selectBatches(current, fields, { signal, maxBlockBytes }),
    commands: {
      scale: {
        parameters: { multiplier: { type: 'number', min: 0, default: 1 } },
        async run({ multiplier }, { signal, outputs, publish, progress, log, maxBlockBytes }) {
          // multiplier is inferred as number.
          const next = values(multiplier);
          for await (const batch of selectBatches(next, outputs, { signal, maxBlockBytes }))
            await publish(batch);
          current = next;
          progress({ completed: 1, total: 1 });
          log({ severity: 'info', message: 'Scale applied.' });
          return { multiplier };
        },
      },
    },
  },
  { url: 'ws://localhost:3000/grid' },
);

await connection.closed;
```

A monitor may yield one `DataBatch` or a bounded array of batches. It may be finite or live.
`selectBatches` reads a captured local `Data` value; it does not subscribe to changes. Implement a
live iterable if the application needs continuous observation. A model that offers no `monitor`
offers no reading. Authentication, retries, addresses, naming, and scheduling belong to the
application.

## Accepting a model

Accept sockets immediately in the WebSocket connection handler, so registration cannot be missed.
For example, with `ws` (an application dependency):

```ts
import { WebSocketServer } from 'ws';
import { acceptModel } from '@latkit/connect';

const server = new WebSocketServer({
  port: 3000,
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
});

server.on('connection', (socket) => {
  void use(socket).catch(console.error);
});

async function use(socket: import('ws').WebSocket) {
  const model = await acceptModel({ socket });
  try {
    const fields = [{ from: 'Bus', select: ['load'] }];
    for await (const publication of model.monitor?.(fields) ?? []) {
      console.log(publication); // readonly DataBatch[]
    }

    const result = await model.commands.scale.run(
      { multiplier: 2 },
      {
        outputs: fields,
        async publish(publication) {
          await storePublication(publication);
        },
        progress: (progress) => console.log(progress),
        log: (diagnostic) => console.log(diagnostic),
      },
    );
    console.log(result);
  } finally {
    await model.close();
  }
}
```

A `ConnectedModel` is a `Model` and a `Connection`: `name`, `schema`, `commands`, `monitor` when
the model offers reading, `close`, and `closed`. A command runs with the same context the model's
own handler receives: whoever runs it supplies `publish` for the outputs it asks for, and may
supply `progress`, `log`, and `signal`. IDs, credits, wire opcodes, and execution bookkeeping stay
inside the connection.

The side that dials offers the subprotocol naming its role, `protocol.subprotocols.connect` or
`protocol.subprotocols.accept`, and the answering side selects it. A server routes on it:

```ts
const { subprotocols } = protocol; // from '@latkit/connect'
const server = new WebSocketServer({
  noServer: true,
  handleProtocols: (offered) =>
    offered.has(subprotocols.connect)
      ? subprotocols.connect
      : offered.has(subprotocols.accept)
        ? subprotocols.accept
        : false,
});
// A socket that negotiated `connect` carries a model to accept; one that negotiated `accept`
// wants a model connected to it.
```

## Serving an accepted model onward

A `ConnectedModel` can be offered again as it is. A server can keep the models that connect to it
and give each browser that dials it the one it names:

```ts
const models = new Map<string, ConnectedModel>();

// On a socket that negotiated `connect`:
const model = await acceptModel({ socket });
models.set(model.name, model);

// On a socket that negotiated `accept`, for the model `name`:
const wanted = models.get(name);
if (wanted) await connectModel(wanted, { socket });
else socket.close(4404, `No model named ${name}.`);
```

Each accepting side gets its own reads and runs over the one connection to the model, each on its
own credit window, so one slow reader slows only its own stream. Publications connect received go
on as the bytes that arrived, with a new 16-byte header, without being validated or encoded again,
whenever they fit the onward connection's bounds. Serving a model that is itself a connection ends
when that connection ends, and its reason closes the connections serving it. A peer that closes the
socket before registering rejects with the close reason it sent, so a server can say why it turned
a socket away. Commands still run one at a time on the model's connection.

## Delivery and ownership

A publication within the negotiated message bounds is delivered as one atomic message. A larger one
is delivered as several messages in order: batches share a message while they fit, and a sample batch
is cut only between whole frames, so the accepting side can append each message as it arrives. A
row batch must fit one message; `selectBatches` bounds them. Models never size messages themselves,
and atomicity does not extend across an entire model or execution. Applications needing a complete
replacement can stage a bounded or persisted stream and expose it when the monitor ends or the
command succeeds. Earlier publications remain valid if a later publication fails. Static
replacement and retained history policies belong to the application.

Always await `publish` before reusing its arrays or publishing again. It resolves when the encoded
copy is safe to reuse and local capacity is available, without waiting for a remote round trip for
each batch. An iterable may reuse its yielded arrays after its next pull. A command's outstanding
publish is awaited even if the handler forgets to await it; overlapping publishes fail.

The accepting side returns credit when its iterator asks for the next publication or its `publish`
resolves. Received arrays are stable, immutable application-owned values; credit release does not
invalidate them. Retaining them consumes application memory, outside connection budgets. Decoded
numeric columns view received storage on little-endian systems. Encoding performs one outgoing
payload copy; native WebSocket implementations may make additional copies.

Requested command outputs require `publish`. A result resolves only after preceding publications
complete. Field demand is checked on both ends. The model must honor row selections and their
domain IDs; the connection does not retain an ID-to-row cache. An empty selection reads nothing.

`progress` coalesces pending updates. `log` keeps a bounded ring and reports dropped entries
explicitly, as one entry carrying the `dropped` count. Messages are truncated to fit metadata
limits. `progress` and `log` are synchronous; await work in `publish`.

The `protocol` namespace provides `decodePublication`, `preparePublication`, the subprotocols, and
the explicit wire codec for storage and gateways. `forward(id, publication.bytes)` frames a received
publication for another stream without encoding it again, as a relay does. Renderers consume `Data`, independent of this
protocol. Payloads omit connection-local IDs and sequences.

## Limits and lifecycle

Both endpoints negotiate the minimum of their `ConnectLimits`:

| Limit                                                                     |                 Default |
| ------------------------------------------------------------------------- | ----------------------: |
| `messageBytes`: a complete message                                        |                   1 MiB |
| `metadataBytes`: JSON metadata                                            |                  64 KiB |
| `bufferedBytes`, `bufferedMessages`: all reserved receive windows         | 16 MiB / 1,024 messages |
| `streamWindowBytes`, `streamWindowMessages`: each stream window           |    4 MiB / 256 messages |
| `streams`: stream descriptors                                             |                      32 |
| `publicationBatches`: batches per publication                             |                      64 |
| `logs`: pending diagnostics per execution                                 |                      32 |
| `timeoutMs`: registration, cancellation response, close, cleanup deadline |              30 seconds |

The global window budget can admit fewer streams than the descriptor ceiling (four full default
windows). New streams fail immediately when reservations are exhausted. One FIFO writer handles
publications and controls, waiting for native send-buffer capacity before encoding. The native
send buffer is capped at `bufferedBytes` before each send. There is one pending publication
per model stream and one pending cumulative ACK per receiver. ACKs read the latest consumed
sequence when sending; terminal ACKs retain the stream reservation until sent. Control pressure
waits for capacity instead of closing the connection.

Pending writes are bounded by admitted streams: each receiver can own a request, a cancellation,
and one ACK; each sender can own a publication and a terminal, with one telemetry write for the
active command. Registration and an idempotent close add constant overhead. Queued publications
may borrow caller storage until encoding; their aggregate encoded sizes fit the reserved windows.
Control metadata is bounded per message and stream; it has no per-publication queue. A run may
also retain one bounded file-argument payload. Sender acknowledgement ledgers retain byte counts,
not payload history. Metadata has a depth limit of 24 and a traversal limit of 8,192 nodes.

Thus connection-owned live queues are bounded independently of total rows, frames, and elapsed
stream duration. These bounds are not a process RSS cap: JavaScript object overhead, GC timing,
caller-owned arrays/history, file copies, and OS/native WebSocket buffers also use memory. Configure
the server WebSocket's inbound message limit as above; browser/native WebSocket may allocate a peer
message before this package receives and rejects it.

Use an `AbortSignal` for a connection, monitor, or run. Returning/breaking a monitor cancels it,
including a pending pull. One command executes per connection, independently of monitors.
Cancellation stops waits promptly; model code must observe its signal and release its resources.
A model that ignores cancellation triggers cancellation/cleanup deadlines, and a command slot
remains busy until its handler exits. There is no forced termination of arbitrary application code.

A completed stream with unread publications retains its bounded reservation until consumed or
cancelled and its terminal ACK is sent. Credit and socket-drain waits have no elapsed-time deadline:
a healthy slow reader can pause indefinitely. Supply an `AbortSignal` when the application needs
an operation deadline. Cancellation response deadlines start once the cancellation is sent, and
close notifications have their own bounded best-effort wait before mandatory local teardown.
Remote closure, protocol faults, and cleanup failures reject `closed`; a successful local close
resolves it. Reconnect explicitly; commands are not replayed, retried, or claimed to execute
exactly once across failures.

## Code layout and verification

- `types.ts`: public API and limits; `Model` and its contexts live in `@latkit/model`.
- `connect.ts` / `accept.ts`: the side offering a model and the side accepting it.
- `session.ts`: routing, credit windows, bounded queues, cancellation.
- `outbound.ts` / `socket.ts`: the single outbound writer, dialing, WebSocket events and
  send-buffer capacity.
- `frame.ts` / `columns.ts`: framing, publication packing, forwarding, and model column encoding.
- `parameters.ts` / `core.ts`: boundary validation and small shared primitives.

Run `pnpm --filter @latkit/connect test`, and `pnpm bench` from the repository root for the
connect benchmark. The tests cover real WebSocket connections in both dialing directions,
demand-only delivery, command/file validation, delayed callbacks, cancellation, disconnects and
close reasons, serving an accepted model onward byte for byte, all column layouts, credit
exhaustion, admission limits, malformed frames, control ordering, 80 MiB backlog recovery,
coalesced terminal ACKs, and slow readers beyond the lifecycle deadline.

This is a breaking replacement. There are no `connect`/`serve`, MessagePort adapters, polling
models, snapshot callbacks, or compatibility wrappers. See [PROTOCOL.md](PROTOCOL.md).
