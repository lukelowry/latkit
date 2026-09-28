# @latkit/port

Where latkit crosses a boundary: a two-method port over workers, webviews, sockets, and one thread;
one binary frame that carries typed arrays intact; typed request, reply, and stream protocols with
the checks their served side runs; and a `@latkit/model` model and its recordings served and
connected across a port.

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
`WebSocket` or a node `ws` socket, queueing posts until it opens. `loopback()` is two ports wired
to each other in one realm, every message crossing as a frame on a microtask: a client and a server
on one thread, or a test's two ends, where `fail(reason)` delivers a transport failure. Each
constructor takes its target structurally, so a `Worker`, a webview API, or a socket passes as it
is; only `Port` is a named type.

Every message is JSON values plus typed arrays (`Uint8Array` through `Float64Array`), anywhere in
the value, on every transport. A service written against a worker runs unchanged against a socket.
`messagePort` does not refuse what structured clone would carry beyond that; `loopback` does.

## A model across a port

```ts
// the worker
import { messagePort, serveModel, serveRecording } from '@latkit/port';

serveModel(messagePort(self), model); // its bytes and, with an engine, its runs
serveRecording(messagePort(self), recording); // a recording the worker keeps

// the page
import { connectModel, connectRecording } from '@latkit/port';

const model = await connectModel(port, { progress });
const run = model.run!(command, { id: 'fault-4' }); // runs on the worker, fills a recording here
const kept = await connectRecording(port, 'fault-4'); // or opens the worker's own
model.close();
```

Only a model's source crosses: the core, each class shard as it is first asked for, the vendor's
bytes, and each run as a stream. The far side opens it with `openModel`, so it is the same `Model`;
a recording opens with `openRecording`, its clock at hand and its samples read in windows. A
connected side is a `Remote<T>`: the model or recording, plus `close`. A run's command is bytes
unless the vendor names its own type, which `serveModel<Command>` checks with its `command` option.

## A protocol

Both ends import one value: the name on the port, the request, reply, and event types, and the
check the served side runs on every request.

```ts
import { check, protocol } from '@latkit/port';

type Request =
  { readonly op: 'greet'; readonly name: string } | { readonly op: 'count'; readonly upTo: number };

export const HELLO = protocol<Request, string, { readonly tick: number }>(
  'hello',
  check.requests<Request>({ greet: { name: check.string }, count: { upTo: check.index } }),
);
```

`check` holds the checks: `string`, `boolean`, `finite`, `index`, `bounded`, `bytes`, `oneOf`,
`nullable`, `optional`, `object`, `array`, `stringMap`, `record`, and `requests`, whose shape map
the compiler keeps exhaustive over the request union's `op` and exact in every field's type. A
check returns when a value is what it claims and throws a `TypeError` naming what is wrong, so a
refused request is answered with that reason and never reaches the handler.

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
with `transferred(value, buffers)`, for a reply or for a streamed item alike. Call options
(`signal`, `progress`, `transfer`) and a handler's shape are stated inline on `call`, `stream`, and
`serve`.
