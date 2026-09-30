# @latkit/port

Where latkit crosses a boundary: a two-method port over workers, webviews, sockets, and one thread;
one binary frame that carries typed arrays intact; typed request, reply, and stream protocols with
the checks their served side runs; and `@latkit/model` engines, models, and recordings served and
connected across a port. A served engine carries all of a vendor on one port: its studies, its
recordings, and a session on each case a peer opens.

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

## Engines, models, and recordings across a port

```ts
// the worker or the server: the cases and the solver are here
import { serveEngine, serveRecording, socketPort } from '@latkit/port';

serveEngine(socketPort(socket), engine); // one engine, every peer on a port of its own
serveRecording(port, recording); // a recording kept on its own

// the page
import { connectEngine, connectRecording, socketPort } from '@latkit/port';

const engine = await connectEngine(socketPort(new WebSocket('/engine')));
const session = await engine.open('ieee39.case.json'); // a session on the peer's document
const model = await session.model(); // its snapshot, packs loading as they are asked for
const recording = engine.record(model, input); // recorded where the model lives, followed here
await engine.save('ieee39.case.json', session.view.version);
const kept = await connectRecording(port, model, 'fault-4'); // or open a kept recording
```

Only views, edits, sources, changes, and the windows read cross; a case never does. A case a
connected engine opens or creates is a session on the one document the peer's engine holds for it,
served on the same port as a document service of its own; a model the session captures is served
beside it, its core at once and each class shard as it is first asked for, and the engine records
it where it lives. An engine records any model it is given: a model its own realm serves is
recorded where it lives, and any other is lent by its source, which the engine reads only as it
needs, for as long as the recording lasts; a file an input gives, or one a case is created from, is
lent the same way, its bytes crossing only as the engine reads them. Each recording is held where
the engine runs, its frames in the engine's store: the far side follows its changes, its clock,
ranges, state, and log, reads its frames a window of at most 4 MiB at a time, and lets it go by
closing it, as the port's close lets every one go. The served engine checks every input, queues
what it cannot take at once, and stops when the far recording stops. The studies and formats an
engine offers cross with it: `connectEngine` resolves once they are in, and the connected engine
follows each change and checks a study's form where it is. A kept recording opens with
`Recording.from` against the model it records. A connected engine, model, or recording closes with
its own `close`.

## Cases across a port

```ts
const session = await engine.open('ieee39.case.json');
session.on('change', () => render(session.view.schematic));
await session.apply({ kind: 'set', element, column: 'kv', value: 138 });
await session.undo();
const bytes = await session.bytes(); // the case as it stands, for a download
const snapshot = await session.model();
// Keep it until every reader or recording using it finishes.
snapshot.close();
session.close(); // the peer's engine keeps the case open or not
```

Opening a session, editing, and exporting native bytes do not build a model. `session.model()`
requests an immutable snapshot only when needed; its bytes remain frozen across later edits.

Every call waits its turn in the one queue of the peer's document, shared by every session on the
case. Edits and reads carry the revision they were made against; one made against a revision gone
by throws `DocumentConflict` and never applies, so an edit sent again after it landed never applies
twice. Refusals retain `Refusal.at`. Updates carry the schematic parts a change replaced, compared
by identity; layout changes retain the netlist and model. A gap refreshes the view.
Acknowledgments mean accepted in memory; `engine.save` makes a version durable, and every session
on the case hears it through `view.saved` and its `saved` event.

`session.inspect(elementOrKey, signal?)` returns `{ version, inspection }`: editable values and
complete wiring read together without materializing a model. Retain the revision with a form and
submit through `session.apply(version, ...operations)`; a stale draft is refused. Inspections
copy only public fields and are bounded to 1 MiB.

Queues, snapshots, and slow-peer update buffers are bounded. Model snapshots reuse scoped model
services (`serveModel` / `connectModel` accept an optional `id`). See
[Document sessions](../../docs/document-sessions.md) for what an engine keeps open, limits, and the
wire contract.

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

## Series

`serveSeries` / `connectSeries` expose a standalone `Series` without transferring its sample store. Reads are bounded and borrowed sample buffers are copied before transfer. Closing the connection leaves the source owned by its host.

```ts
const stop = serveSeries(port, series, { id: 'voltage', snapshot: true });
const remote = await connectSeries(port, { id: 'voltage', signal });
const block = await remote.read(0, window, signal);
remote.close();
stop();
```

`snapshot: true` pins the committed prefix at serve time and reports a sealed remote history. Without it, the connection follows appended frames and sealing. A failed live connection stops appends, preserves its last valid state, and rejects subsequent reads and lookups with the original failure. IDs allow multiple histories to share a port.
