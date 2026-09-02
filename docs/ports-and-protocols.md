# Ports and protocols

`@latkit/port` carries messages between the two halves of one application: a page and its worker,
an extension host and its webview, a browser and a server. `@latkit/remote` uses it to serve a
`@latkit/model` model, and what a run of it recorded, from whichever half holds the data.

## A port

A `Port` posts messages, delivers the peer's, and says when its transport ended. Three constructors
cover the boundaries applications meet:

| Constructor   | Over                                                    | Carries                                    |
| ------------- | ------------------------------------------------------- | ------------------------------------------ |
| `messagePort` | a `Worker`, a worker's global scope, any message target | structured clone, with a transfer list     |
| `bytePort`    | any channel that carries bytes faithfully               | one binary frame per message               |
| `socketPort`  | a browser `WebSocket` or a node `ws` socket             | frames; posts queue until the socket opens |

Every message is JSON values plus typed arrays (`Uint8Array` through `Float64Array`), anywhere in
the value. That is what one binary frame carries, and holding to it on every transport means a
service written against a worker runs unchanged against a socket. A frame decodes its typed arrays
as views into the received buffer, so a topology or a run's samples cross without a copy on the
receiving side. `messagePort` does not refuse what structured clone would carry beyond that value
model; the framed `loopback` in `@latkit/port/testing` does.

```ts
import { messagePort } from '@latkit/port';

const port = messagePort(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
```

Each constructor takes its target structurally, so a `Worker`, a webview API, or a socket passes as
it is; `Port` is the one named type on that side of the surface.

## A protocol

A protocol is one value both ends import: its name on the port, its request, reply, and event
types, and the guard the served side checks requests with. Guards come from `@latkit/port/guard`;
`requests` keeps the map exhaustive over the request union's `op`.

```ts
import { protocol } from '@latkit/port';
import { index, requests, str } from '@latkit/port/guard';

export type SearchRequest =
  | { readonly op: 'find'; readonly text: string }
  | { readonly op: 'select'; readonly index: number };

export interface SearchState {
  readonly hits: readonly string[];
  readonly selected: number | null;
}

export const SEARCH = protocol<SearchRequest, SearchState, SearchState>(
  'search',
  requests<SearchRequest>({ find: { text: str }, select: { index } }),
);
```

## Serve and connect

The half with the data serves; the other half connects. Several protocols share one port, and each
side sees only its own. A request the guard refuses is answered with an error and never reaches the
handler.

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

## Serve a model

`@latkit/remote` serves a `Source` and, when the serving side has an engine, a `Runner`. Only bytes
cross: the core, one shard per class as it is first asked for, and the vendor source. A run is one
stream. The connecting side opens the same `Model` the serving side holds.

```ts
// worker.ts
import { sourceOf } from '@latkit/model';
import { messagePort } from '@latkit/port';
import { serveSource } from '@latkit/remote';

serveSource(messagePort(self), { source: sourceOf(model) });

// page.ts
import { openModel } from '@latkit/model';
import { connectSource } from '@latkit/remote';

const remote = await connectSource(port);
const model = await openModel(remote.source, {
  progress: (loaded, total) => bar.set(loaded / total),
});
```

Every connected side in `@latkit/remote` is a `Remote<T>`: what the peer serves, plus `close`.
`connectSource` resolves a `RemoteSource`, a `Remote<Served>` with the `reopen` that continues the
served lineage.

A grid is served the same way: `serveGrid` publishes the header and answers windows of display text,
and `connectGrid` hands the page a `Grid` (with its `GridHeader`) it binds to a table.

## Serve results

What a run recorded is served as a `Results`: one class's batches per stream, the same `RunFrames`
the run itself streamed, so `collect` folds either. The batches describe their own shape, and
nothing is published ahead of a read.

```ts
// host.ts
import { serveResults } from '@latkit/remote';

const stop = serveResults(port, store); // `store` implements `Results` over whatever it holds

// page.ts
import { collect } from '@latkit/model';
import { connectResults } from '@latkit/remote';

const results = connectResults(port); // a `Remote<Results>`
monitor.load(await collect(results.read('bus', [0], signal), frames));
results.close();
```

A read selects signals by recorded-order index, or every recorded signal with `null`. A served side
that must bound what one read asks for passes `{ maxSignals }`; by default a selection is unbounded.

## Test across a port

`@latkit/port/testing` provides an in-memory pair whose messages cross as frames, so a payload that
would not survive a byte port fails in the unit lane.

```ts
import { loopback, settle } from '@latkit/port/testing';

const [server, client] = loopback();
serve(server, SEARCH, handler);
const search = connect(client, SEARCH);
await settle();
client.fail('worker crashed'); // every connection on `client` closes with this reason
```
