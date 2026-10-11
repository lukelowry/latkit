# Geography

Draw the earth and what lies on it: ground, areas, lines, and their labels, flat or on a globe.

```ts
import { createGeography, geojson } from '@latkit/geography';

const states = await geojson(text, { type: 'State', id: 'adm1_code' });
const geography = createGeography(gpu, {
  canvas,
  source: states,
  areas: {
    State: { color: { field: 'load', domain: [0, 1], colormap: 'viridis' }, labels: 'name' },
  },
  lines: { State: { points: 'rings', widthPx: 0.8 } },
  camera: { projection: 'globe' },
});
```

An area fills its row's `rings` of longitude and latitude; a hole winds opposite its outline. A
line strokes its `points`, or an area type's `rings` as its outline. Areas draw in order over the
ground, and lines over areas. Channels and labels work as in every view; see
[data bindings](topology-and-channels.md#channels).

## Beneath a network

```ts
const ground = createGeography(gpu, { source: borders, lines: { Border: { widthPx: 0.8 } } });
const network = createNetwork(gpu, { canvas, source, vertices, edges, geography: ground });
```

A geography without a canvas draws beneath the network in its pass, with its camera, `at`, and
depth. Its sun lights the graph, and a gesture on no vertex or edge reaches it. The network never
destroys it.

## Sources

- **Data**: rows whose `rings` or `points` are lists of `[longitude, latitude]` vectors.
- **`geojson(json)`**: Data from GeoJSON, parsed in a worker. Polygons give `rings`, lines give
  `points`, and properties become fields.
- **`tiles(from)`**: vector tiles, from a PMTiles archive, a `{z}/{x}/{y}` template, or TileJSON,
  by URL or held locally. Each layer is a type. `persist: true` keeps fetched tiles for offline use.
- **`pack(data, { areas, lines })`**: the shapes prepared ahead, as PMTiles bytes that `tiles()`
  reads and draws without preparing anything.

Shapes prepare in workers: cut at the antimeridian, simplified alike along shared borders, and
filed by place, so a frame draws only what is in view at the detail it shows. `values` colors the
shapes by the rows of another Data with the same ids, such as a run's results over a static map.

## Routes

A line follows its coordinates in longitude and latitude: a border along a parallel stays on it.
`route: 'geodesic'` follows the great circle between its points instead.

## Style

```ts
geography.set({ daylight: 'now', graticule: true, earthAxis: true });
```

`surfaceColor`, `graticuleColor`, `atmosphereColor`, and `earthAxisColor` color the ground and what
draws on it. `areaColor`, `lineColor`, and `lineWidthPx` stand in for rows without their own.
`daylight` lights the scene by the sun at a time; `nightFloor` and `terminatorWidth` shape the night.

## Limits

Each tile source holds at most `limits.tileBytes` on the GPU, 64 MiB by default, and keeps
`limits.requests` in flight, 8 by default. The least recently drawn tiles go first.

[API](https://latkit.readthedocs.io/en/latest/api/reference/geography/index.html)
