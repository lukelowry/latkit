# @latkit/network

One network view over borrowed model `Queryable` sources and the shared `Gpu`. Native indices and row numbers remain authoritative for selection, neighborhoods, field bindings, and labels. Destroying a view does not close its sources or GPU.

```ts
import { colormaps } from '@latkit/gpu';
import { createNetwork, attachNetworkInput } from '@latkit/network';

const network = createNetwork({
  gpu,
  data: {
    source: document,
    coordinates: 'geographic',
    vertices: {
      location: {
        position: 'coordinates',
        color: {
          field: { source: recording, from: 'location', field: 'signal' },
          colormap: colormaps.viridis,
        },
        labels: { field: 'name', maxCount: 120 },
      },
    },
    edges: {
      route: {
        connectivity: { kind: 'endpoints', layout: 'pair' },
        bends: 'waypoints',
        curve: 'geodesic',
        labels: { field: 'name', maxCount: 40 },
      },
      junction: {
        connectivity: { kind: 'endpoints', layout: 'star' },
        // Optional `junction: 'coordinates'`; omitted uses the endpoint centroid.
      },
    },
    paths: {
      border: {
        source: geography,
        points: 'coordinates',
        widthPx: 0.8,
        baseColor: [0.45, 0.62, 0.68, 0.7],
      },
    },
  },
  options: { hover: 'auto', hoverBudgetMs: 2, poles: false },
});
const detach = attachNetworkInput({ network, canvas });
network.setVertex('location', { height: { field: 'elevation', domain: 'auto' } });
network.setPath('border', { widthPx: 1.2 });
```

`points` and `bends` are native lists of two-component numeric vectors. A star's optional `junction` uses the same vector or `{ x, y }` field binding as vertex positions. Synthetic bends and junctions never appear as model vertices. `paths` are decorative unless `pickable: true`; their events use `kind: 'path'` and the original source, index, and row. Border styling belongs to the path declaration.

Omitted scale domains and `'auto'` both use finite values over the complete displayed mapping at the current coordinate. Use `[0, 1]` for normalized signals, or `{ window: { kind: 'frames', offset: 0, count: 100 } }` for a stable recording extent. Window extents use GPU's shared aggregate/read cache. Null and missing values retain style defaults; constant domains map to the output midpoint. Output ranges may descend.

Native query blocks are assembled into dense draw banks. Geometry and field uploads are cached independently of the camera. GPU geodesics use adaptive one-degree segments, bounded reusable scratch, and indirect draws without CPU readback. Their physical segment count may exceed `stats().segments`, which counts logical strokes. Detailed static borders remain cached during coordinate playback. Geodesics and paths share projection, clipping, styles, focus, and the stroke renderer. Explicit hit tests and label anchors evaluate the same arc geometry; automatic hover remains subject to its cooperative budget.

Vertex visibility controls markers; edge visibility controls connections independently. Star neighborhoods include every native endpoint. Focus uses indexed endpoint masks. Vertex, connection, and path labels share bounded candidate selection, collision placement, generic anchors, and GPU's text atlas. Text runs remain stable when only anchor visibility or position changes. Multi-segment dashed paths compute screen-length prefixes only when a dash field is bound.

## Verification

```sh
pnpm --filter @latkit/gpu test
pnpm --filter @latkit/network test
pnpm --filter @latkit/network test:browser
```

The browser command opens a headed fixture and leaves it available. Controls include recording channels, geodesics, detailed Natural Earth borders, poles, hover policy, and geometry features. The report records CPU submission time, complete-frame time, cache misses, uploaded bytes, and median/p95 timings for 100,000 vertices and 199,367 connections, including coordinate playback with borders. Native border assets contain 96,965 points across 2,423 polylines. They are linework, without polygon interiors or hole ownership; region filling is not inferred from them.

Shared `Scale`, `ColorScale`, `Position2D`, `Shade`, colors and DOM input primitives are imported
from `@latkit/gpu`. Native index/row/text helpers are imported from `@latkit/model`. Network no
longer exports duplicate scale or shade contracts. Fields resolve to native CPU views before an
explicit selected upload; labels consume the same field bindings and GPU text atlas.
