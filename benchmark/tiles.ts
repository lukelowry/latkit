/**
 * A Vite plugin that serves vector tiles made on request, so the tiles scenario fetches over HTTP
 * as a map does, with the same bytes every run and no network. `/tiles/<squares>/<z>/<x>/<y>.mvt`
 * returns one layer, `cells`, of that many squares in a grid over the tile.
 */
import type { Plugin } from 'vite';

export function tiles(): Plugin {
  return {
    name: 'bench-tiles',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/tiles\/(\d+)\/\d+\/\d+\/\d+\.mvt$/.exec(req.url ?? '');
        if (!match) return next();
        res.setHeader('content-type', 'application/vnd.mapbox-vector-tile');
        res.end(tile(Number(match[1])));
      });
    },
  };
}

const varint = (n: number): number[] => {
  const out: number[] = [];
  for (; n > 127; n = Math.floor(n / 128)) out.push((n % 128) | 128);
  return [...out, n];
};
const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const key = (field: number, wire: number) => varint((field << 3) | wire);
const bytes = (field: number, payload: number[]) => [
  ...key(field, 2),
  ...varint(payload.length),
  ...payload,
];

/** Encodes a tile of `squares` squares as exterior rings, clockwise in the tile's 4096-unit extent
 * (y down). */
function tile(squares: number): Uint8Array {
  const side = Math.ceil(Math.sqrt(squares));
  const step = Math.floor(4096 / side);
  const size = Math.floor(step * 0.8);
  const features = Array.from({ length: squares }, (_, i) => {
    const [x, y] = [(i % side) * step, Math.floor(i / side) * step];
    // MoveTo one point, LineTo three, ClosePath.
    const path = [
      9,
      zigzag(x),
      zigzag(y),
      26,
      zigzag(size),
      0,
      0,
      zigzag(size),
      zigzag(-size),
      0,
      15,
    ];
    return bytes(2, [
      ...key(1, 0),
      ...varint(i + 1),
      ...key(3, 0),
      3,
      ...bytes(4, path.flatMap(varint)),
    ]);
  });
  const name = [...new TextEncoder().encode('cells')];
  const layer = [
    ...key(15, 0),
    2,
    ...bytes(1, name),
    ...features.flat(),
    ...key(5, 0),
    ...varint(4096),
  ];
  return new Uint8Array(bytes(3, layer));
}
