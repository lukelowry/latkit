# Retain a data version

Use `Queryable.retain()` when several reads or an export must see the same data.

```ts
const fixed = await recording.retain({
  window: { kind: 'range', between: [0, 10], context: { before: 1, after: 1 } },
  maxBytes: 64 * 1024 * 1024,
});
try {
  for await (const block of fixed.query({
    kind: 'samples',
    from: 'Bus',
    select: ['Vm'],
    window: { kind: 'range', between: [0, 10] },
  })) {
    if (block.kind === 'samples') console.log(block.coordinates);
  }
} finally {
  await fixed.close();
}
```

Retention fixes schema, data, row identities, and observations.
Queries outside its coverage reject rather than silently clipping.
A nested retained acquisition has its own lifetime and may narrow coverage.

A live recording starts over when the next recording command begins.
Retained results survive that replacement and the parent's closure.
Always close each acquisition you own.

File editing, undo, persistence, and sharing belong to the application.
There is no public `Document.Session` API in the current model contract.
