# Connecting models

A model is a value: `Model` from `@latkit/model`, with a name, a schema, an optional `monitor` that
reads fields, and commands. `@latkit/connect` carries one across a WebSocket. One side offers it
with `connectModel`, the other accepts it with `acceptModel`, and either side may dial:

```ts
import { connectModel } from '@latkit/connect';
import { selectBatches } from '@latkit/model';

const connection = await connectModel(
  {
    name: 'grid',
    schema: currentData.schema,
    monitor: (fields, { signal, maxBlockBytes }) =>
      selectBatches(currentData, fields, { signal, maxBlockBytes }),
  },
  { url: 'ws://localhost:3000/grid' },
);
await connection.closed;
```

The URL is dialed exactly as given. Registration sends metadata only; the accepting side requests
observations explicitly:

```ts
import { acceptModel } from '@latkit/connect';
import { createData } from '@latkit/model';

const model = await acceptModel({ socket });
try {
  for await (const publication of model.monitor?.([{ from: 'Bus', select: ['voltage'] }], {
    signal: stop.signal,
  }) ?? []) {
    const data = createData(model.schema, publication);
    view.set({ source: data });
  }
} finally {
  await model.close();
}
```

A browser can dial a server the same way, `acceptModel({ url })`, and the server offers it a model
on the socket it accepted, `connectModel(model, { socket })`. An accepted model is itself a `Model`,
so a server can offer the models that connected to it onward, unchanged; publications go on as the
bytes that arrived.

Each publication arrives as one atomic message when it fits the negotiated bounds; a larger one
arrives as several, cutting sample batches only between whole frames. The example displays each
message independently; accumulating a complete model or retaining history is an explicit application
storage policy. `Data` values remain valid after the connection closes.

`model.commands.solve.run(values, { outputs, publish, progress, log, signal })` runs a command. The
model's own handler receives the same context, with `maxBlockBytes`. Await publication writes for
bounded streaming. Monitoring remains independent of commands.

Credits bound how far a model runs ahead and how much each reader queues, by both bytes and message
count. Returning an iterator or aborting cancels the operation. Native WebSocket inbound limits
should match connection limits.

The `protocol` namespace of `@latkit/connect` implements the explicit binary codec and names the
subprotocols. Model values and renderers do not depend on WebSocket framing.

See the [connection guide](https://github.com/lukelowry/latkit/blob/main/packages/connect/README.md)
for complete examples, limits, ownership, and cancellation semantics, and the
[wire specification](https://github.com/lukelowry/latkit/blob/main/packages/connect/PROTOCOL.md)
for interoperability. The old connect/serve, MessagePort wrappers, polling model services,
snapshot callbacks, and transaction events have been removed.
