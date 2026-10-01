# Data bindings

Renderers read native `Queryable` fields. Mapping keys name model types.

## Positions and wiring

A model's topology is its reference fields. A reference holds rows of another
type, read as a `ReferenceColumn` of row numbers under that type's `Index`.

```ts
const bus = { type: { kind: 'reference', to: 'Bus' } } as const;
const schema = {
  queries: ['rows'],
  limits: { maxBlockBytes: 1 << 20 },
  types: {
    Bus: {
      fields: { position: { type: { kind: 'vector', items: 'float64', size: 2 } } },
      spatial: { field: 'position', system: 'geographic' },
    },
    Branch: { fields: { bus1: bus, bus2: bus } },
    Load: { fields: { bus } },
  },
};
const data = { source, vertices: { Bus: {} }, edges: { Branch: { ends: ['bus1', 'bus2'] } } };
```

Vertex and edge are what a view draws, not what a type is. An edge with `ends`
joins the two vertices its reference fields name. Without `ends` the type is a
net: each row joins the vertices whose references name it, so
`{ vertices: { Load: {} }, edges: { Bus: {} } }` draws every bus as a star of its
loads. A diagram draws those references as ports; `direction: 'in' | 'out'` on a
reference field orients them.

The drawn types' spatial system sets the coordinates: geographic positions are
longitude/latitude in degrees, cartesian positions use application units.
Positions default to the spatial field and can also be two-component vectors or
separate `{ x: 'longitude', y: 'latitude' }` fields. Paths and bends use lists of
two-component vectors.

## Style by field

```ts
network.setVertex('Bus', {
  color: {
    field: { source: recording, from: 'Bus', field: 'temperature' },
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
