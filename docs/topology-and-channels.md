# Topology and channels

Use this guide when adapting real network data to `@latkit/network`.

## Topology arrays

`Topology` is the CPU-side graph shape passed to `network.load()`.

| Field             | Length            | Meaning                                              |
| ----------------- | ----------------- | ---------------------------------------------------- |
| `vertexCount`     | `1` number        | Number of logical graph vertices                     |
| `vertexCoords`    | `vertexCount * 2` | Optional interleaved `x, y` or `lon, lat` values     |
| `coordinateSpace` | N/A               | Optional `'cartesian'` or `'geographic'` declaration |
| `edges`           | `edgeCount * 2`   | Endpoint vertex indices as `from, to` pairs          |
| `polylineStart`   | `edgeCount + 1`   | Offset table into `polylinePoints`                   |
| `polylinePoints`  | `pointCount * 2`  | Optional bend points for edge polylines              |

Omit `vertexCoords` to use the generated unit-ring layout. Generated coordinates are always
abstract. Caller-supplied coordinates inside longitude and latitude bounds are inferred geographic
unless `coordinateSpace: 'cartesian'` opts out. `coordinateSpace: 'geographic'` documents intent,
but coordinates must still fit those bounds.

For straight edges with no bend points, use a zero-filled `polylineStart` with `edgeCount + 1` entries:

```ts
const topology: Topology = {
  vertexCount: 4,
  vertexCoords: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  edges: new Uint32Array([0, 1, 1, 2, 2, 3]),
  polylineStart: new Uint32Array([0, 0, 0, 0]),
};
```

For a bent edge, place the intermediate points in `polylinePoints` and use `polylineStart` to mark the range for each edge:

```ts
const topology: Topology = {
  vertexCount: 2,
  vertexCoords: new Float32Array([-96, 30, -94, 31]),
  edges: new Uint32Array([0, 1]),
  polylineStart: new Uint32Array([0, 2]),
  polylinePoints: new Float32Array([-95.5, 30.8, -94.8, 31.1]),
};
```

## Projection support

All projections use resolved vertex coordinates for topology fit bounds. Flat and tilt accept
arbitrary coordinates. Globe additionally requires a geographic interpretation, longitude in
`[-180, 180]`, latitude in `[-90, 90]`, a non-trivial geographic span, and a characteristic length
small enough for globe rendering. Item-specific edge framing still includes that edge's polyline
bends.

Read support after `load()`:

```ts
network.load(topology);

console.log(network.geographic);
if (network.projections.globe) {
  network.setProjection('globe');
}
```

## Channel arrays

Channels bind scalar values to vertices or edges after a topology is loaded.

| Channel         | Length        | Effect                                       |
| --------------- | ------------- | -------------------------------------------- |
| `vertexColor`   | `vertexCount` | Colors vertices through the active colormap  |
| `vertexHeight`  | `vertexCount` | Raises vertices and height poles             |
| `vertexSize`    | `vertexCount` | Scales vertex billboards                     |
| `vertexVisible` | `vertexCount` | Shows vertices whose value is greater than 0 |
| `edgeColor`     | `edgeCount`   | Colors edges through the active colormap     |
| `edgeDash`      | `edgeCount`   | Enables per-edge dash pattern values         |
| `edgeVisible`   | `edgeCount`   | Shows edges whose value is greater than 0    |

```ts
network.load(topology);

network.setChannel('vertexColor', vertexLoad, [0, 1]);
network.setChannel('edgeColor', edgeStress, [0, 100]);
network.setChannel('vertexHeight', vertexLoad, null);
network.setOptions({ heightRange: [0, 0.8] });
network.setChannel('vertexVisible', energizedVertices);
network.setChannel('edgeVisible', energizedEdges);
network.setChannel('edgeVisible', null);
```

The third argument is the input domain. Pass `null` to auto-scan height values. The `heightRange` option is the output range `vertexHeight` maps onto. `setChannelDomain()` moves a bound channel's domain without re-uploading its values, and `getChannelDomain()` reads the domain in effect. Visibility channels are raw and domain-free: an unbound channel shows every item, while a bound channel shows only values greater than zero. Zero, negative values, and `NaN` hide the item in both rendering and hit testing. Passing `null` as the values clears the channel and restores all items.

`setChannel()` snapshots its typed array, so later caller mutations do not alter the bound rendering or picking state. Bind the array again to publish changes. `CHANNELS` lists every channel with its scope, display label, and whether it is normalized.

## Validation failures

`network.load()` throws if lengths, endpoints, or polyline offsets are invalid. `setChannel()` throws if no topology is loaded or the channel length does not match the current topology.
