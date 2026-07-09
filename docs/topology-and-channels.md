# Topology and channels

Use this guide when adapting real network data to `@latkit/network`.

## Topology arrays

`Topology` is the CPU-side graph shape passed to `network.load()`.

| Field            | Length            | Meaning                                      |
| ---------------- | ----------------- | -------------------------------------------- |
| `vertexCount`    | `1` number        | Number of logical graph vertices             |
| `vertexCoords`   | `vertexCount * 2` | Interleaved `x, y` or `lon, lat` coordinates |
| `edges`          | `edgeCount * 2`   | Endpoint vertex indices as `from, to` pairs  |
| `polylineStart`  | `edgeCount + 1`   | Offset table into `polylinePoints`           |
| `polylinePoints` | `pointCount * 2`  | Optional bend points for edge polylines      |

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

Flat and tilt projections accept arbitrary coordinates. Globe projection is available only when loaded bounds look geographic: longitude in `[-180, 180]`, latitude in `[-90, 90]`, a non-trivial geographic span, and a characteristic length small enough for globe rendering.

Read support after `load()`:

```ts
network.load(topology);

if (network.projections.globe) {
  network.setProjection('globe');
}
```

## Channel arrays

Channels bind scalar values to vertices or edges after a topology is loaded.

| Channel        | Length        | Effect                                      |
| -------------- | ------------- | ------------------------------------------- |
| `vertexColor`  | `vertexCount` | Colors vertices through the active colormap |
| `vertexHeight` | `vertexCount` | Raises vertices and height poles            |
| `vertexSize`   | `vertexCount` | Scales vertex billboards                    |
| `edgeColor`    | `edgeCount`   | Colors edges through the active colormap    |
| `edgeDash`     | `edgeCount`   | Enables per-edge dash pattern values        |

```ts
network.load(topology);

network.setChannel('vertexColor', vertexLoad, [0, 1]);
network.setChannel('edgeColor', edgeStress, [0, 100]);
network.setChannel('vertexHeight', vertexLoad, [0, 1], [0, 0.8]);
```

The third argument is the input domain. Pass `null` to auto-scan height values. The fourth argument is the output height range and only applies to `vertexHeight`.

## Validation failures

`network.load()` throws if lengths, endpoints, or polyline offsets are invalid. `setChannel()` throws if no topology is loaded or the channel length does not match the current topology.
