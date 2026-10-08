# Connecting models

A model is a `Model` from `@latkit/model`: a `name`, a `schema`, an optional `monitor` that reads
fields, and `commands`. `@latkit/connect` carries one across a WebSocket.
`connectModel(model, { url } | { socket })` offers it, and `acceptModel({ url } | { socket })`
accepts it as a `ConnectedModel`. Either side may dial: `url` is dialed exactly as given, and
`socket` is one a server already accepted.

## Offer a model

```ts
import { connectModel } from '@latkit/connect';
import { selectBatches } from '@latkit/model';

let data = initialData;

const connection = await connectModel(
  {
    name: 'grid',
    schema: data.schema,
    monitor: (fields, { signal, maxBlockBytes }) =>
      selectBatches(data, fields, { signal, maxBlockBytes }),
    commands: {
      scale: {
        parameters: { multiplier: { type: 'number', min: 0, default: 1 } },
        async run({ multiplier }, { signal, outputs, publish, progress, log, maxBlockBytes }) {
          const next = scaled(data, multiplier);
          for await (const batch of selectBatches(next, outputs, { signal, maxBlockBytes }))
            await publish(batch);
          data = next;
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

Registration sends only the schema and command descriptions; values move when the accepting side
asks for them. A monitor yields `DataBatch` values or bounded arrays of them, once or live; a model
without one offers no reading. `selectBatches` reads one captured `Data` value and does not follow
later changes, so a live monitor yields new batches itself.

A handler's context comes from whoever runs the command, and its return value, finite JSON, is the
result. Authentication, retries, addresses, naming, and scheduling belong to the application.

## Accept a model

Accept each socket in the WebSocket connection handler, so registration cannot be missed. For
example, with `ws`:

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

A `ConnectedModel` is a `Model` and a `Connection`. [Application-owned data](document-sessions.md)
builds values from its publications. A run that asks for outputs must supply `publish`, and its
result resolves after every preceding `publish` completes. `progress` and `log` are synchronous,
so await work in `publish`.

## Route by role

The dialing side offers the subprotocol naming its role, `protocol.subprotocols.connect` or
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
```

A socket that negotiated `connect` carries a model to accept; one that negotiated `accept` wants a
model offered to it.

## Serve a model onward

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

Each accepting side gets its own reads and runs over the one connection to the model, each with
its own credit window, so a slow reader slows only its own stream. Received publications go on as
the bytes that arrived, behind a new 16-byte header, without being validated or encoded again,
whenever they fit the onward bounds. Commands still run one at a time on the model's connection.
Serving ends when the served connection ends, and its reason closes the connections serving it. A
peer that closes the socket before registering rejects with the close reason it sent, so a server
can say why it turned a socket away.

## Delivery and ownership

A publication within the negotiated message bounds arrives as one atomic message. A larger one
arrives as several, in order: batches share a message while they fit, and a sample batch is cut
only between whole frames, so each message can be appended as it arrives. A row batch must fit one
message; `selectBatches` bounds them. Atomicity covers one publication, not a whole model or run:
to swap in a complete replacement, stage the stream and expose it when the monitor ends or the
command succeeds. Earlier publications stay valid if a later one fails.

Await `publish` before reusing its arrays or publishing again; an overlapping publish fails. It
resolves without a round trip per batch, and a command's pending publish is awaited even if its
handler forgets to. A monitor may reuse the arrays it yielded after its next pull.

Received batches are immutable and belong to the application. They stay valid after their credit
is returned and after the connection closes. Holding them uses application memory, outside the
connection's budgets. On little-endian systems, decoded numeric columns view the received bytes.

Both sides reject a publication carrying fields that were not requested. The model must honor row
selections and their domain IDs; the connection keeps no ID-to-row cache. An empty selection reads
nothing.

## Flow control and limits

The accepting side grants each stream a window of bytes and messages. A model waits while its
window is full, and the accepting side returns credit when its iterator pulls the next publication
or its `publish` resolves. Credit and socket-drain waits have no deadline: a healthy slow reader
can pause indefinitely. Pass an `AbortSignal` when an operation needs a deadline.

Both sides negotiate the minimum of their `ConnectLimits`, passed as `limits` to `connectModel` or
`acceptModel`:

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

The default budget holds four full windows, fewer than `streams`. A new stream fails at once when
the budget is exhausted, and a finished stream keeps its window until its publications are read or
cancelled. Connection queues are bounded by the admitted streams, not by rows, frames, or how long
a stream runs. That is not a process memory cap: arrays the application holds, file copies, and
native WebSocket buffers use memory too. Cap the server's inbound message size at `messageBytes`,
as `maxPayload` does above; a browser or native WebSocket may allocate a peer's message before
this package rejects it.

## Cancellation and lifecycle

Pass an `AbortSignal` as `signal` to a connection, a monitor, or a run. Returning or breaking out
of a monitor loop cancels it, including a pending pull. One command runs at a time per connection,
independently of monitors; another run fails with `busy`. Cancellation stops waits promptly, but
model code must observe its signal and release its resources. A model that ignores cancellation
loses its connection after `timeoutMs`, and its handler runs on until it returns: nothing forcibly
stops application code.

`closed` rejects on remote closure, protocol faults, and cleanup failures; a local `close()`
resolves it. Reconnect explicitly: commands are never replayed or retried, and no run is claimed to
execute exactly once across failures.

## Wire format

The `protocol` namespace holds the wire codec for storage and gateways: frames (`prepare`,
`decode`, `forward`, `Op`), publications (`preparePublication`, `decodePublication`), and
`subprotocols`. `forward(id, encoded.bytes)` frames an `EncodedPublication` for another stream
without encoding it again. The
[wire specification](https://github.com/lukelowry/latkit/blob/main/packages/connect/PROTOCOL.md)
defines the format, and the [API reference](api/reference/connect/index.md) lists every option.
