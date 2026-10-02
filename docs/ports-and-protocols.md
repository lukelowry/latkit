# Connecting models

`@latkit/connect` provides two ends of a demand-driven connection: a producer calls
`connectLattice`; a host calls `acceptModel` on the arriving WebSocket.

```ts
import { connectLattice } from '@latkit/connect';
import { selectBatches } from '@latkit/model';

const connection = await connectLattice({
  url: 'http://localhost:3000',
  name: 'grid',
  schema: currentData.schema,
  monitor(fields, { signal, maxBatchBytes }) {
    return selectBatches(currentData, fields, { signal, maxBlockBytes: maxBatchBytes });
  },
});
await connection.closed;
```

Registration sends metadata only. The host requests observations explicitly:

```ts
import { acceptModel } from '@latkit/connect';
import { createData } from '@latkit/model';

const model = await acceptModel(socket);
try {
  let sequence = 0;
  for await (const publication of model.monitor([{ from: 'Bus', select: ['voltage'] }], {
    signal: stop.signal,
  })) {
    const data = createData(model.schema, String(++sequence), publication);
    view.set({ source: data });
  }
} finally {
  await model.close();
}
```

Each publication is a bounded atomic group of column batches. The example displays each group
independently; accumulating a complete model or retaining history is an explicit application
storage policy. `Data` values remain valid after the connection closes.

The host's `model.run(name, values, { outputs, onData, onProgress, onLog, signal })` requests
command output. The producer's handler receives typed arguments and
`{ outputs, publish, progress, log, signal, maxBatchBytes }`. Await publication writes and data
callbacks for bounded streaming. Monitoring remains independent of commands.

Credits bound producer lead and receiver queues by both bytes and message count. Returning an
iterator or aborting cancels the operation. A single slow page must not be allowed to create an
unbounded host fan-out queue. Native WebSocket inbound limits should match connection limits.

For gateways, `format: 'encoded'` delivers validated connection-independent payloads.
`@latkit/connect/protocol` implements the explicit versioned binary codec. Model values and
renderers do not depend on WebSocket framing.

See the [connection guide](https://github.com/lukelowry/latkit/blob/main/packages/connect/README.md)
for complete producer/host examples, limits, ownership, and cancellation semantics, and the
[wire specification](https://github.com/lukelowry/latkit/blob/main/packages/connect/PROTOCOL.md)
for interoperability. The old connect/serve, MessagePort wrappers, polling Model/Commands,
snapshot callbacks, and transaction events have been removed.
