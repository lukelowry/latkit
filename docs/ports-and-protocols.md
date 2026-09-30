# Ports and protocols

`@latkit/port` carries messages between the two halves of one application: a page and its worker,
an extension host and its webview, a browser and a server. It serves `@latkit/model` models,
engines, and recordings from whichever half holds them, and carries any protocol an application
declares itself.

## A port

A `Port` posts messages, delivers the peer's, and says when its transport ended. Four constructors
cover the boundaries applications meet:

| Constructor   | Over                                                    | Carries                                    |
| ------------- | ------------------------------------------------------- | ------------------------------------------ |
| `messagePort` | a `Worker`, a worker's global scope, any message target | structured clone, with a transfer list     |
| `bytePort`    | any channel that carries bytes faithfully               | one binary frame per message               |
| `socketPort`  | a browser `WebSocket` or a node `ws` socket             | frames; posts queue until the socket opens |
| `loopback`    | nothing: two ports wired to each other in one realm     | frames, delivered on a microtask           |

Every message is JSON values plus typed arrays (`Uint8Array` through `Float64Array`), anywhere in
the value. That is what one binary frame carries, and holding to it on every transport means a
service written against a worker runs unchanged against a socket. A frame decodes its typed arrays
as views into the received buffer, so a topology or a recording's samples cross without a copy on
the receiving side. `messagePort` does not refuse what structured clone would carry beyond that value
model; the framed `loopback` does, so a test or a same-thread client catches what strays.

```ts
import { messagePort } from '@latkit/port';

const port = messagePort(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
```

Each constructor takes its target structurally, so a `Worker`, a webview API, or a socket passes as
it is; `Port` is the one named type on that side of the surface.

## Serve an engine

An engine is a vendor: served on one port, it carries all of it. The half that holds the cases
and the solver serves the engine; the other half connects and gets an `Engine` whose cases,
studies, and recordings are the peer's. A case it opens is a `Document.Session` on the document the
peer holds, served as a document service of its own on the same port, so the case never crosses:
only its view, the edits made to it, and the models it captures do, a model's core at once and one
shard per class as it is first asked for.

An engine records any model it is given. A model its realm serves, as every session's is, is
recorded where it lives; any other is lent by its source for as long as the recording lasts, the
engine reading only what it needs, and a file an input gives is lent the same way. Each recording
is held where the engine runs, its frames in the engine's store; the caller's side follows its
changes as they come and reads its frames a window at a time, and closing it lets the engine's
side let it go.

```ts
// worker.ts: the cases and the solver are here.
import { messagePort, serveEngine } from '@latkit/port';

serveEngine(messagePort(self), new GridkitEngine(cases, lanes));

// page.ts
import { connectEngine, messagePort } from '@latkit/port';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const engine = await connectEngine(messagePort(worker));
engine.formats; // what it opens and creates
await engine.cases(); // what it keeps
const session = await engine.open('ieee39.case.json');
const model = await session.model();
const recording = engine.record(model, input, { id: 'fault-4' });
network.setChannel('vertexColor', await recording.field(VM));
recording.on('change', () => status(recording.state)); // waiting → recording → complete | stopped | failed

// On teardown:
recording.close();
model.close();
session.close();
await engine.close();
```

The served engine checks every input with its own `parse`, queues what it cannot take at once and
says how many wait ahead, and stops when the far recording stops. A connected engine resolves once
the studies and formats its peer offers are in; it offers them too, following each change, and
checks a study's form where it is, so a refusal comes before anything crosses. Closing it stops
what it follows and closes the connection; the peer lets go of every recording and session the
connection held, and keeps each case's unsaved edits.

## Serve a model

A model outside any engine, such as one a catalog holds, is served on its own: the other half
connects and gets the same `Model`, its classes loading across the port as they are asked for. A
model opened from packs serves them as they came, so a relay decodes nothing. One model is served
per port or per scoped id; closing the connected model closes its connection.

```ts
import { connectModel, serveModel } from '@latkit/port';

serveModel(port, catalogModel);
const model = await connectModel(peerPort, {
  progress: (loaded, total) => bar.set(loaded / total),
});
```

## Serve a recording

A `Recording` is every signal an engine recorded for one model, every class on one clock. Served
by its id, it crosses the port as its source: each class's shape, then its changes from the first,
carrying its clock, where it stands, and its log, and sample windows only when read. The far side
opens it with `Recording.from` against the model it records, which checks that it fits, so
`frameAt`, `timeAt`, and every series' `locate` answer there at once.

```ts
// Host: a recording its engine fills, or any other Recording.
import { serveRecording } from '@latkit/port';
const stop = serveRecording(port, recording);

// Page: the id of the recording the host selected, and the model it records.
import { connectRecording } from '@latkit/port';
const remote = await connectRecording(port, model, recordingId);
const vm = await remote.field({ classId: 'bus', kind: 'signal', id: 'Vm' });
monitor.load(vm);

// On teardown:
remote.close();
```

Several recordings can share a port because each service is named by its id. A sample window
carries at most 4 MiB, time included, and a series on the far side asks for at most 1 MiB at a time,
however large the window it is asked for. A window outside the committed frames is refused on the
far side before it crosses, and samples cross as copies the receiver owns, so a producer's retained
buffers stay usable. Closing either endpoint ends pending reads and the changes.

## A protocol

An application's own services are protocols: one value both ends import, with its name on the port,
its request, reply, and event types, and the check the served side runs on every request. `check`
holds the checks a request is composed from; `check.requests` keeps the map exhaustive over the
request union's `op`, and the compiler keeps every field's check the field's type.

```ts
import { check, protocol } from '@latkit/port';

export type SearchRequest =
  | { readonly op: 'find'; readonly text: string }
  | { readonly op: 'select'; readonly index: number };

export interface SearchState {
  readonly hits: readonly string[];
  readonly selected: number | null;
}

export const SEARCH = protocol<SearchRequest, SearchState, SearchState>(
  'search',
  check.requests<SearchRequest>({ find: { text: check.string }, select: { index: check.index } }),
);
```

A check returns when a value is what it claims and throws a `TypeError` naming what is wrong when it
is not: a refused `select` says `search request.index must be a nonnegative safe integer`.

## Serve and connect

The half with the data serves; the other half connects. Several protocols share one port, and each
side sees only its own. A request the check refuses is answered with the check's error and never
reaches the handler.

```ts
// worker.ts
import { messagePort, serve } from '@latkit/port';

const search = serve(messagePort(self), SEARCH, async (request) => {
  if (request.op === 'find') state = { ...state, hits: find(request.text) };
  else state = { ...state, selected: request.index };
  return state;
});
search.emit(state); // push state between calls

// page.ts
import { connect } from '@latkit/port';

const search = connect(port, SEARCH);
search.on((state) => render(state));
render(await search.call({ op: 'find', text: 'north' }));
```

A call takes `signal`, `progress`, and `transfer` as an inline options literal; aborting the signal
cancels the handler through its own `signal` and rejects the call with `AbortError`. A handler
failure rejects that one call with the handler's message. A reply whose buffers the handler
relinquishes is wrapped with `transferred(value, buffers)`, for a reply or a streamed item. Either
side may `close`; a transport failure closes every connection on the port with its reason. A call to
a protocol no peer serves settles only when the transport closes, which is why both ends import one
protocol value rather than agreeing on a name.

## Stream

A handler that returns an async iterable streams: one `yield` per item, and the service awaits the
port's `drain` between items so backpressure reaches the producer. Leaving the loop early or
aborting the signal cancels the handler and ends the iteration quietly.

```ts
serve(port, LINES, async function* (request, signal) {
  for await (const line of tail(request.path, signal)) yield line;
});

for await (const line of connect(port, LINES).stream(request, { signal })) print(line);
```

## Test across a port

`loopback()` is a pair of ports whose messages cross as frames, so a payload that would not survive
a byte port fails in the unit lane, and `fail(reason)` on either end delivers a transport failure.

```ts
import { connect, loopback, serve } from '@latkit/port';

const [server, client] = loopback();
serve(server, SEARCH, handler);
const search = connect(client, SEARCH);
client.fail('worker crashed'); // every connection on `client` closes with this reason
```

## Edit a case across a port

`engine.open` and `engine.create` on a connected engine answer with a session on the peer's
document: asynchronous editing with a view kept on this side, revision conflicts, and immutable
model snapshots recorded where they live. See [Document sessions](document-sessions.md) for the
API, what the engine keeps open, resource limits, and the wire contract.
