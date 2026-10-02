# Application-owned data

Keep a `Data` value when several reads, views, or an export must see the same observations.
The value already contains its schema, row identities, and column pages. No model acquisition
or lifetime operation is needed.

```ts
import { read } from '@latkit/model';

const fixed = currentData; // Ordinary immutable application value.
for await (const block of read(fixed, {
  kind: 'samples',
  from: 'Bus',
  select: ['voltage'],
  window: { kind: 'range', between: [0, 10] },
})) {
  if (block.kind === 'samples') console.log(block.coordinates);
}
```

Explicit frame requests outside supplied observations reject. Queries cannot retrieve missing
history from a model. To save incoming observations, apply delivered patches to application
storage using `appendData`; to replace them, use `createData`. Neither helper communicates
with a producer or stores anything outside its returned value.

Pass a value to `createNetwork`, `createMonitor`, or `createDiagram` as `source`, and supply
changes with `view.set({ source: nextData })`. Share unchanged pages to preserve caches and
GPU uploads. Monitor can continue its existing image when shared pages prove an append.

File editing, undo, persistence, memory limits, and sharing belong to the application.
Unsubscribing or closing a connection does not invalidate values already delivered. There is
no `retain`, `Recording`, model history export, or replay endpoint.
