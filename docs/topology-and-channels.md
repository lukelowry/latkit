# Data bindings

Renderers read immutable application-owned `Data` fields. Mapping keys name model types.

## Positions and wiring

A model's topology is its reference fields. A reference holds rows of another
type, read as a `ReferenceColumn` of row numbers under that type's `Index`.

```ts
const bus = { type: { kind: 'reference', to: 'Bus' } } as const;
const schema = {
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
network.set({
  vertices: {
    Bus: {
      color: {
        field: { source: observations, from: 'Bus', field: 'temperature' },
        domain: [0, 100],
        colormap: 'thermal',
      },
      size: { field: 'capacity', domain: [0, 1000], range: [3, 12] },
      labels: { field: 'name', maxCount: 100 },
    },
  },
  at: 12,
});
```

A string names a field of the mapping's own source and type; `color: 'load'` is shorthand for
`{ field: 'load' }`. A binding object reads another source, whose indices and sampled coordinates
must align. Omitted domains fit the displayed values; explicit domains keep colors stable during
playback. Missing values keep style defaults.

Selections and hits keep source, index, and physical row. Do not reuse rows after their source's
index version changes.
