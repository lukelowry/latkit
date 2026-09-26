# @latkit/remote

A `@latkit/model` model served across a `@latkit/port`: its source and runner, and its results as
the batches a run streamed. Whichever side holds the data serves; the other side opens the same
`Model`, runs the same `Runner`, and reads the same `Results`.

## Install

```sh
npm install @latkit/model @latkit/port @latkit/remote
```

## Serve a model

The peer that holds the bytes serves a `Source`, and a `Runner` when it has an engine. Only bytes
cross: the core, one shard per class as it is first asked for, and the vendor source.

```ts
// a worker, or a server's socket handler
import { sourceOf } from '@latkit/model';
import { messagePort } from '@latkit/port';
import { serveSource } from '@latkit/remote';

const model = await vendor.open(bytes);
serveSource(
  messagePort(self),
  { source: sourceOf(model), runner: engine.runnerFor(model) },
  { onClose: () => self.close() },
);
```

A command is bytes by default. A vendor whose commands are structured names its type and guards it
where the untrusted peer sends it, so neither side needs a codec:

```ts
import { bytes, object, optional, str } from '@latkit/port/guard';

const isCommand = object<Command>({ app: str, params: optional(bytes) });
serveSource<Command>(port, served, { command: isCommand });
```

## Open it from the other side

```ts
import { openModel } from '@latkit/model';
import { connectSource } from '@latkit/remote';

const remote = await connectSource(port);
const model = await openModel(remote.source, {
  progress: (loaded, total) => bar.set(loaded / total),
});

if (remote.runner) {
  for await (const update of remote.runner.run(command, signal)) {
    if (update.type === 'frames') frames.push(update);
  }
}

remote.close();
```

A run is one stream over the port: cancelling its signal aborts the runner on the serving side,
and a peer that cannot run has no `runner`.

Every connected side is a `Remote<T>`: what the peer serves, plus `close`. `connectSource`
resolves a `Remote<Served>`, and `connectSource<Command>` one whose runner takes that command;
`connectResults` returns a `Remote<Results>`.

## Serve results

A `Results` holds one result identified by `id`. Its classes expose `Series` histories:
metadata and append notifications cross the port, and samples cross only when requested.

```ts
// Host: store implements Results over memory or a file.
import { serveResults } from '@latkit/remote';
const stop = serveResults(port, store);

// Page: resultId is the id of the recording the host selected.
import { connectResults } from '@latkit/remote';
const results = connectResults(port, resultId);
monitor.load(await results.series('bus'), 0);

// On teardown:
results.close();
```

Several results can share a port because each service is named by its result id.
`series(classId)` is cached and follows committed appends automatically. Its `read` and `locate`
methods accept cancellation signals. A locate call receives the captured frame count, so a
concurrent append cannot change which timestamps that lookup includes.

Sample windows are capped at 4 MiB by default; `serveResults(port, store, { maxBytes })` changes
the cap. The service validates bounds before reading and copies borrowed samples before transfer.
A producer's retained buffers remain usable.

`results.read(classId, signals, signal)` also streams frame-major batches for export or collection.
Signal indices are in recorded order; null selects every signal. `maxSignals` optionally bounds
that selection. Closing either endpoint ends pending work and releases append subscriptions.
