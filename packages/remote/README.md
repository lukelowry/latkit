# @latkit/remote

A `@latkit/model` model served across a `@latkit/port`: its source and runner as one served lineage,
and its grids as windows of display text. Whichever side holds the data serves; the other side
opens the same `Model`, runs the same `Runner`, and binds the same `Grid`.

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
  {
    reopen: async (edited) => ({ source: sourceOf(await vendor.open(edited)) }),
    onClose: () => self.close(),
  },
);
```

`reopen` continues the lineage: the peer sends edited bytes, the server serves the next model in
place, and every earlier remote is superseded.

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

const next = await remote.reopen(editedBytes); // `remote` now owns nothing
remote.close(); // closes the connection when it is the current remote
```

A run is one stream over the port: cancelling its signal aborts the runner on the serving side,
and a peer that cannot run has no `runner`.

## Serve a grid

A grid stays where its columns are; only the header and windows of display text cross.

```ts
// the side with the data
import { createGrid } from '@latkit/model';
import { serveGrid } from '@latkit/remote';

const grid = serveGrid(port, 'case');
grid.set(createGrid(labels, columns), {
  rowCount: labels.length,
  columns: columns.map(({ id, label }) => ({ id, label })),
});

// the side with the table
import { connectGrid } from '@latkit/remote';

const stop = connectGrid(port, 'case', (remote) => {
  if (!remote) return table.clear();
  table.bind(remote); // a `Grid` plus its `GridHeader`
});
```

Every `set` publishes a fresh binding; a window asked of a replaced grid answers empty rather than
failing, since the client already holds the newer header.
