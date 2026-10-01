# Workers and sockets

Use a Latkit model across a worker or socket.

## Worker

Serve an application-owned, authorized model:

```ts
import { serve, messagePort } from '@latkit/connect';
import { model } from './model.js';

await serve(messagePort(self), model);
```

Connect from the host:

```ts
import { connect, messagePort } from '@latkit/connect';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const model = await connect(messagePort(worker));
try {
  console.log(await model.describe());
  await model.run({ routine: 'solve', values: {} });
} finally {
  await model.close();
  worker.terminate();
}
```

The connection implements `Model`. Closing it releases its recordings, retained
reads, and commands. `serve` borrows the root model and never closes it.

## WebSocket

```ts
import { connect, webSocket } from '@latkit/connect';

const model = await connect(webSocket(new WebSocket(url)), {
  signal,
  limits: { maxInFlightBytes: 8 * 1024 * 1024, maxStreams: 32 },
});
```

Use `byteTransport(channel)` for a custom ordered channel of complete binary
messages. Typed arrays remain binary, and streams apply backpressure.

## Read-only access

Both peers must explicitly select the queryable capability:

```ts
import { serve } from '@latkit/connect';

await serve(transport, source, { kind: 'queryable', signal });
```

```ts
import { connect } from '@latkit/connect';

const source = await connect(transport, { kind: 'queryable', signal });
```

This exposes queries and retention, without commands or exports.
Retain a live source first if the consumer needs fixed data.

Authentication, authorization, and reconnection belong to your application.
A lost command reply does not prove the command failed; do not retry blindly.
Use compatible package releases on both peers.

[API](https://latkit.readthedocs.io/en/latest/api/reference/connect/index.html)
