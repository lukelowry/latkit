# Data bindings

A view draws the rows of a `Data` value. Keys of `vertices`, `edges`, and `paths` name its types.

## Positions and wiring

A model's topology is its reference fields. Each reference names a row of another type.

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

Vertex and edge are what a view draws, not what a type is. An edge with `ends` joins the two
vertices its reference fields name. Without `ends`, the type is a net: each row joins the vertices
whose references name it. So `{ vertices: { Load: {} }, edges: { Bus: {} } }` draws every bus as a
star of its loads. A [diagram](diagram-quickstart.md) draws those references as ports.

`x` and `y` are channels like any other. A `geographic` field holds longitude or latitude in
degrees, which the globe and geodesic routes need; other fields are plane units. A vector field
binds one lane per axis: `x: 'position', y: { field: 'position', component: 1 }`. A path's `points`
and an edge's `bends` read lists of two-component vectors. [Layout](views.md#layout) places rows
without a position.

## Channels

Every per-row option is a channel: one value for every row, a field, or a field through a scale.

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

A string names a field of the entry's own source and type. A `{ source, from, field }` binding
reads another source by physical row, so its indices and sampled coordinates must align.

A field reads through its channel's scale. Positions read as they are, and colors through a
colormap. Sizes, widths, `z`, and `flowPx` map the field's extent onto the channel's range.
`domain` and `range` replace those defaults. An omitted domain fits the displayed values; give one
to keep colors stable during playback.

Rows a field leaves empty take the scale's `missing` value, or else the view's default for the
channel, such as `vertexColor` or `edgeWidthPx`. A boolean channel such as `visible` or `dash` is
on where it reads true or positive.
