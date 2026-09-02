# @latkit/port

Where messages cross: a two-method port over workers, webviews, and sockets; one binary frame that
carries typed arrays intact; and typed request, reply, and stream protocols served and connected
over a port. No dependencies.

## Install

```sh
npm install @latkit/port
```

## A port

```ts
import { messagePort, socketPort } from '@latkit/port';

const worker = messagePort(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
const server = socketPort(new WebSocket('wss://example.org/model'));
```

A `Port` has `post`, `subscribe`, and an optional `drain` that resolves once the transport has room
for more. `messagePort` wraps anything with the DOM message-target shape and carries what
structured clone carries, transfer list included. `bytePort` wraps any channel that carries bytes
faithfully and rides each message on one binary frame, so typed arrays view the received buffer in
place even where structured clone does not survive. `socketPort` is `bytePort` over a browser
`WebSocket` or a node `ws` socket, queueing posts until it opens.

Every message is JSON values plus typed arrays (`Uint8Array` through `Float64Array`), anywhere in
the value, on every transport. A service written against a worker runs unchanged against a socket.
`messagePort` does not refuse what structured clone would carry beyond that; the framed `loopback`
in `@latkit/port/testing` does.

## A protocol

Both ends import one value: the name on the port, the request, reply, and event types, and the
guard the served side checks requests with.

```ts
import { protocol } from '@latkit/port';
import { index, requests, str } from '@latkit/port/guard';

type Request =
  { readonly op: 'greet'; readonly name: string } | { readonly op: 'count'; readonly upTo: number };

export const HELLO = protocol<Request, string, { readonly tick: number }>(
  'hello',
  requests<Request>({ greet: { name: str }, count: { upTo: index } }),
);
```

`@latkit/port/guard` holds the guards: `str`, `bool`, `finite`, `index`, `bounded`, `bytes`,
`oneOf`, `nullable`, `optional`, `object`, `arrayOf`, `stringMap`, `keyedRecord`, and `requests`,
whose shape map the compiler keeps exhaustive over the request union's `op`. A guarded request that
fails is answered with an error and never reaches the handler.

## Serve and connect

```ts
// the worker
import { serve } from '@latkit/port';

const hello = serve(port, HELLO, async (request) => {
  if (request.op === 'greet') return `Hello, ${request.name}.`;
  return String(request.upTo);
});
hello.emit({ tick: 1 });

// the page
import { connect } from '@latkit/port';

const hello = connect(port, HELLO);
hello.on((event) => console.log(event.tick));
const greeting = await hello.call({ op: 'greet', name: 'Ada' }, { signal });
hello.close();
```

Several protocols share one port; each `serve` and `connect` sees only its own. A handler failure
rejects that one call with the handler's message. A cancelled call aborts the handler's `signal`.
Either side may close; a transport failure closes every connection on the port with its reason. A
call to a protocol no peer serves settles only when the transport closes, which is why one protocol
value is imported at both ends.

## Stream

A handler that returns an async iterable streams, one `yield` per item, and the service awaits the
port's `drain` between items so backpressure reaches the producer.

```ts
serve(port, FRAMES, async function* (request, signal) {
  for await (const frame of engine.run(request, signal)) yield frame;
});

for await (const frame of connect(port, FRAMES).stream(request, { signal })) paint(frame);
```

Leaving the loop early, or aborting `signal`, cancels the handler and ends the iteration quietly. A
handler failure ends it with that error. A reply whose buffers the handler relinquishes is wrapped
with `transferred(value, buffers)`, for a reply or for a streamed item alike.

## Testing

```ts
import { loopback, settle } from '@latkit/port/testing';

const [server, client] = loopback();
serve(server, HELLO, handler);
const hello = connect(client, HELLO);
await settle(); // let microtask deliveries land
client.fail('worker crashed'); // every connection on `client` closes with this reason
```

`loopback` frames every message, so a test payload that would not survive a byte port fails in the
unit lane.
