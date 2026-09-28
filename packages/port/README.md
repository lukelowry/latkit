# @latkit/port

Where latkit crosses a boundary: a two-method port over workers, webviews, sockets, and one thread;
one binary frame that carries typed arrays intact; typed request, reply, and stream protocols with
the checks their served side runs; and `@latkit/model` models, engines, and recordings served and
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

## Models, engines, and recordings across a port

```ts
// the worker: cases parse here, and the engine records here
import { messagePort, serveEngine, serveModel, serveRecording } from '@latkit/port';

serveEngine(messagePort(self), new GridkitEngine(server)); // records any model a peer gives it
serveRecording(messagePort(self), recording); // a recording the worker keeps
self.addEventListener('message', ({ data }) => {
  // one case per channel, its packs served as they are asked for
  if (data.open) serveModel(messagePort(data.open.port), new GridkitCase(data.open.bytes));
});

// the page
import { connectEngine, connectModel, connectRecording, messagePort } from '@latkit/port';

const port = messagePort(worker);
const engine = connectEngine(port);
const { port1, port2 } = new MessageChannel();
worker.postMessage({ open: { port: port2, bytes } }, [port2]);
const model = await connectModel(messagePort(port1), { progress });
const recording = engine.record(model, study); // fills here as the worker's engine writes it
const kept = await connectRecording(port, model, 'fault-4'); // or opens the worker's own
```

Only sources and recorder calls cross. A model's core crosses at once and each class shard as it is
first asked for, with the case's bytes on request; a model opened from packs serves them as they
came. An engine records any model it is given: a model its own realm serves is recorded where it
lives, and any other is lent by its source, which the engine reads only as it needs, for as long
as the recording lasts. Each recording crosses as the engine writes it, call by call, its frames
handed over without a copy; the served engine checks every input, queues what it cannot take at
once, and stops when the far recording stops. A kept recording opens with `Recording.from` against
the model it records, its clock at hand and its samples read in windows of at most 4 MiB. A
connected side is a `Remote<T>`: the model, engine, or recording, plus `close`.

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
  for await (const frame of frames(request, signal)) yield frame;
});

for await (const frame of connect(port, FRAMES).stream(request, { signal })) paint(frame);
```

Leaving the loop early, or aborting `signal`, cancels the handler and ends the iteration quietly. A
handler failure ends it with that error. A reply whose buffers the handler relinquishes is wrapped
with `transferred(value, buffers)`, for a reply or for a streamed item alike. Call options
(`signal`, `progress`, `transfer`) and a handler's shape are stated inline on `call`, `stream`, and
`serve`.
