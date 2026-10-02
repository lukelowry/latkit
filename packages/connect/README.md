# @latkit/connect

One-pass model observation and optional commands over workers, messages, or sockets.

```ts
// Worker: commands are optional and independent of the model.
import { serve, messagePort } from '@latkit/connect';
import { model, commands } from './application.js';

await serve(messagePort(self), model, { commands });
```

```ts
// Host: save or render delivered values in the application.
import { connect, messagePort } from '@latkit/connect';
import { transactions } from '@latkit/model';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const connection = await connect(messagePort(worker));
const stop = new AbortController();
try {
  for await (const data of transactions(
    connection.schema,
    connection.monitor([{ from: 'Bus', select: ['voltage'] }], { signal: stop.signal }),
  )) {
    show(data);
  }
} finally {
  await connection.close();
  worker.terminate();
}
```

When controls are offered, use `connection.commands.run(command)` independently of observation.
Omitting `commands` from `serve` produces a passive connection. There is one model contract;
there are no queryable roots, historical queries, retention references, or remote exports.

Closing a connection cancels that peer's active subscriptions and commands. It never closes
the served model or invalidates delivered data. Application-held typed arrays remain usable
for local reads and rendering. Reverse command file streams are bounded and cancelled when
the command finishes or aborts. A pre-aborted command leaves unopened inputs untouched.

```ts
import { connect, webSocket } from '@latkit/connect';
const connection = await connect(webSocket(new WebSocket(url)), {
  signal,
  limits: { maxInFlightBytes: 8 * 1024 * 1024, maxStreams: 32 },
});
```

Use `byteTransport(channel)` for a custom ordered channel of complete binary messages.
Typed arrays stay binary. Pull credit bounds in-flight payloads; transfer preparation never
detaches application buffers. Only active subscription and command-input streams have remote
references. Delivery validates schema, transaction order, version, columns, and payload bounds.

This breaking contract uses protocol version **3**; older peers fail negotiation. Upgrade both
ends together. Authentication, authorization, and reconnection belong to the application.
A lost command reply does not prove the command failed; automatic retries require an
application-level idempotency policy.

[API](https://latkit.readthedocs.io/en/latest/api/reference/connect/index.html)
