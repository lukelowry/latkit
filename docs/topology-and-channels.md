# Data bindings

Renderers read native `Queryable` fields. Mapping keys name model types.

## Positions and connections

```ts
const data = {
  source,
  coordinates: 'geographic' as const,
  vertices: { node: { position: 'coordinates' } },
  edges: {
    line: { connectivity: { kind: 'endpoints' as const, layout: 'pair' as const } },
  },
};
```

Geographic positions are longitude/latitude in degrees. Cartesian positions use
application units. Positions can be two-component vectors or separate
`{ x: 'longitude', y: 'latitude' }` fields.

Connections expose native endpoints. Use `pair` for two endpoints and `star`
for several. Paths and bends use lists of two-component vectors.

## Style by field

```ts
network.setVertex('node', {
  color: {
    field: { source: recording, from: 'node', field: 'temperature' },
    domain: [0, 100],
    colormap: colormaps.thermal,
  },
  size: { field: 'capacity', domain: [0, 1000], range: [3, 12] },
  labels: { field: 'name', maxCount: 100 },
});
view.request({ at: 12 });
```

A string names a field on the mapping's source and type. An explicit binding
selects another source. Native indices and sampled coordinates must align.
Use immutable bindings and publish changes through renderer setters.

Omitted domains use finite values across the displayed mapping. Explicit domains
keep scales stable during playback. Missing values keep style defaults.

Selections and hits retain source, index, and physical row identity.
Do not reuse row indices after their source index version changes.
