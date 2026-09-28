# Ports and protocols

`@latkit/port` carries messages between the two halves of one application: a page and its worker,
an extension host and its webview, a browser and a server. It serves a `@latkit/model` model, and
what a run of it recorded, from whichever half holds the data, and carries any protocol an
application declares itself.

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
as views into the received buffer, so a topology or a run's samples cross without a copy on the
receiving side. `messagePort` does not refuse what structured clone would carry beyond that value
model; the framed `loopback` does, so a test or a same-thread client catches what strays.

```ts
import { messagePort } from '@latkit/port';

const port = messagePort(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
```

Each constructor takes its target structurally, so a `Worker`, a webview API, or a socket passes as
it is; `Port` is the one named type on that side of the surface.

## Serve a model

The half that holds a model serves it; the other half connects and gets the same `Model`, its
classes loading across the port as they are asked for. Only bytes and run updates cross: the core,
one shard per class as it is first asked for, the vendor's bytes, and each run as one stream. A
model with an engine runs on it from the far side, filling a recording there.

```ts
// worker.ts
import { createModel } from '@latkit/model';
import { messagePort, serveModel } from '@latkit/port';

const model = createModel({ ...description, load, bytes, run: engine.run });
serveModel(messagePort(self), model);

// page.ts
import { connectModel } from '@latkit/port';

const model = await connectModel(port, { progress: (loaded, total) => bar.set(loaded / total) });
const run = model.run!(command, { id: 'fault-4', span: [0, 20], signal });
network.setChannel('vertexColor', await model.field(VM, run.recording));
for await (const update of run) status(update); // queued · running · log · done | cancelled | failed

// On teardown:
model.close();
```

A connected model is a `Remote<Model>`: the model, plus `close`. A run's command is bytes unless
the vendor names its own type, which `serveModel<Command>` checks with the `command` option; one
run goes at a time, and cancelling it aborts the engine. A model still opening can be served as a
promise, so no early request is lost.

## Serve a recording

A `Recording` is one run's output, every class on one clock. Served by its id, it crosses the port
as its source: its declaration and each class's shape, its clock from the first frame and then each
change, and sample windows only when read. The far side opens it with `openRecording`, so
`frameAt`, `timeAt`, and every series' `locate` answer there at once.

```ts
// Host: the recording a run fills, or any other Recording.
import { serveRecording } from '@latkit/port';
const stop = serveRecording(port, recording);

// Page: the id of the recording the host selected.
import { connectRecording } from '@latkit/port';
const remote = await connectRecording(port, recordingId);
const vm = await model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }, remote);
if (vm) monitor.load(vm);

// On teardown:
remote.close();
```

Several recordings can share a port because each service is named by its id. Sample windows are
capped at 4 MiB by default; `serveRecording(port, recording, { maxBytes })` changes the cap. A
window outside the committed frames is refused on the far side before it crosses, and samples cross
as copies the receiver owns, so a producer's retained buffers stay usable. Closing either endpoint
ends pending reads and the changes.

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
serve(port, FRAMES, async function* (request, signal) {
  for await (const frame of engine.run(request, signal)) yield frame;
});

for await (const frame of connect(port, FRAMES).stream(request, { signal })) paint(frame);
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
