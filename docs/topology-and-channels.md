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
      fields: {
        longitude: { type: 'float64', geographic: true },
        latitude: { type: 'float64', geographic: true },
      },
    },
    Branch: { fields: { bus1: bus, bus2: bus } },
    Load: { fields: { bus } },
  },
};
const data = {
  source,
  vertices: { Bus: { x: 'longitude', y: 'latitude' } },
  edges: { Branch: { ends: ['bus1', 'bus2'] } },
};
```

Vertex and edge are what a view draws, not what a type is. An edge with `ends`
joins the two vertices its reference fields name. Without `ends` the type is a
net: each row joins the vertices whose references name it, so
`{ vertices: { Load: {} }, edges: { Bus: {} } }` draws every bus as a star of its
loads. A diagram draws those references as ports; `direction: 'in' | 'out'` on a
reference field orients them.

`x` and `y` are where each row draws, bound like any other channel. A field
marked `geographic` holds longitude or latitude in degrees, which the globe and
geodesic routes need; otherwise its coordinates are plane units. A vector field
binds one lane per axis: `x: 'position', y: { field: 'position', component: 1 }`.
Paths and bends use lists of two-component vectors.

## Channels

Every per-row option is a channel: one value for every row, a field, or a field
through a scale.

```ts
network.set({
  vertices: {
    Bus: {
      color: {
        field: { source: observations, from: 'Bus', field: 'temperature' },
        domain: [0, 100],
        colormap: 'thermal',
        missing: [0.4, 0.4, 0.4, 1],
      },
      radiusPx: { field: 'capacity', domain: [0, 1000], range: [3, 12] },
      z: 'load',
      visible: true,
      labels: { field: 'name', maxCount: 100 },
    },
  },
  at: 12,
});
```

A string names a field of the mapping's own source and type. A binding object reads another
source, whose indices and sampled coordinates must align. A field reads through its channel's
scale: positions as they are, colors through a colormap, and radii, widths, `z`, and `flowPx` from
their field's extent onto the channel's range. `domain` and `range` replace those; omitted domains
fit the displayed values, and explicit ones keep colors stable during playback. Rows a field leaves
empty take the scale's `missing` value, or else the view's default for that channel, named after
it: `vertexColor`, `vertexRadiusPx`, `edgeWidthPx`, `traceColor`. A boolean channel such as
`visible` or `dash` is on where it reads true or positive.

Selections and hits keep source, index, and physical row. Do not reuse rows after their source's
index version changes.
