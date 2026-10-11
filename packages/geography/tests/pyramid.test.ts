import { expect, it } from 'vitest';
import { kit, type ProjectedCamera } from '@latkit/gpu';
import { Pyramid, tileBounds, type TileKey } from '../src/scene/pyramid.js';
import { visibleRegion } from '../src/scene/visible.js';
import type { TileSource } from '../src/sources/archive.js';
import type { TileSet } from '../src/tiles.js';

const source: TileSource = {
  minZoom: 0,
  maxZoom: 14,
  bounds: [-180, -85.0511287798, 180, 85.0511287798],
  metadata: {},
  tile: () => Promise.resolve(null),
};
const pyramid = new Pyramid<object>({
  tiles: { source: () => Promise.resolve(source) } as unknown as TileSet,
  bytes: 1e9,
  requests: 8,
  load: () => new Promise(() => {}),
  size: () => 0,
  release: () => {},
  loaded: () => {},
  fail: (error) => {
    throw error;
  },
});
const viewport = { width: 1200, height: 800, pixelRatio: 1 };
/** The tiles a camera draws, as the pyramid chooses them. */
function wanted(camera: Partial<ProjectedCamera>): TileKey[] {
  const projector = new kit.Projector({ ...kit.Projector.camera, fit: false, ...camera }, viewport);
  return (
    pyramid as unknown as {
      wanted(p: kit.Projector, s: TileSource, r: ReturnType<typeof visibleRegion>): TileKey[];
    }
  ).wanted(projector, source, visibleRegion(projector));
}

it('draws the tiles under a camera however near the globe it comes, magnified past the deepest', () => {
  const center = [-122.42, 37.77] as const;
  // From the whole globe down to a street, a degree spanning ever more pixels.
  for (const scale of [3, 30, 300, 3000, 30000, 300000, 3000000])
    for (const projection of ['globe', 'flat', 'mercator'] as const)
      for (const pitch of projection === 'globe' ? [0, 50] : [0]) {
        const tiles = wanted({ projection, center, scale, pitch });
        expect(tiles.length, `${projection} at ${scale}, pitch ${pitch}`).toBeGreaterThan(0);
        // The tile under the center draws first.
        const [w, s, e, n] = tileBounds(tiles[0].z, tiles[0].x, tiles[0].y);
        expect(center[0] >= w && center[0] <= e && center[1] >= s && center[1] <= n).toBe(true);
        // Past the source's deepest zoom, its deepest tiles draw on, magnified.
        expect(Math.max(...tiles.map((t) => t.z))).toBeLessThanOrEqual(source.maxZoom);
      }
  expect(Math.max(...wanted({ projection: 'globe', center, scale: 3000000 }).map((t) => t.z))).toBe(
    14,
  );
});
