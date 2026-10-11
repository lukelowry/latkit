import { describe, expect, it } from 'vitest';
import { kit } from '@latkit/gpu';
import { BREAK, prepareShapes, type Shapes, type ShapesInput } from '../src/prepare/shapes.js';
import { levelFor, visibleRanges, visibleRegion } from '../src/scene/visible.js';
import { pick, type Drawn } from '../src/picking.js';
import { geojson } from '../src/geojson.js';
import { pack, readPack, packKey } from '../src/pack.js';
import { openTiles } from '../src/sources/archive.js';

/** Rows of rings or polylines, each a list of parts of [lon, lat] points. */
function input(rows: number[][][][], closed: boolean): ShapesInput {
  const rowParts = [0],
    parts = [0],
    coordinates: number[] = [];
  for (const row of rows) {
    for (const part of row) {
      for (const [x, y] of part) coordinates.push(x, y);
      parts.push(coordinates.length / 2);
    }
    rowParts.push(parts.length - 1);
  }
  return {
    closed,
    rowParts: Uint32Array.from(rowParts),
    parts: Uint32Array.from(parts),
    coordinates: Float64Array.from(coordinates),
  };
}
const square = (x: number, y: number, size: number) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];
/** A vertex's longitude and latitude. */
function at(shapes: Shapes, v: number): [number, number] {
  const rows = new Uint32Array(shapes.vertices.buffer, shapes.vertices.byteOffset, shapes.vertices.length),
    row = rows[v * 3 + 2],
    o = shapes.origins;
  return [o[row * 4] + o[row * 4 + 2] + shapes.vertices[v * 3], o[row * 4 + 1] + o[row * 4 + 3] + shapes.vertices[v * 3 + 1]];
}
const viewport = { width: 800, height: 600, pixelRatio: 1 };

describe('prepareShapes', () => {
  it('fills and strokes neighboring areas at every level, filed in a quadtree', () => {
    const shapes = prepareShapes(input([[square(0, 0, 10)], [square(10, 0, 10)]], true));
    expect(shapes.rows).toBe(2);
    expect(shapes.extent).toEqual([0, 0, 20, 10]);
    const last = shapes.levels.at(-1)!;
    expect(last.tolerance).toBe(0);
    for (const level of shapes.levels) {
      expect(level.triangles.length % 3).toBe(0);
      expect(level.triangles.length).toBeGreaterThan(0);
      // Each outline strip closes on its first point and ends with a break.
      expect(level.strips.at(-1)).toBe(BREAK);
      expect(level.along.length).toBe(level.strips.length);
    }
    // Every triangle lies inside the squares, its vertices on the same row.
    const rows = new Uint32Array(shapes.vertices.buffer, shapes.vertices.byteOffset, shapes.vertices.length);
    for (let t = 0; t < last.triangles.length; t += 3) {
      const r = [0, 1, 2].map((k) => rows[last.triangles[t + k] * 3 + 2]);
      expect(new Set(r).size).toBe(1);
      const [x, y] = at(shapes, last.triangles[t]);
      expect(x).toBeGreaterThanOrEqual(-1e-4);
      expect(x).toBeLessThanOrEqual(20 + 1e-4);
      expect(y).toBeGreaterThanOrEqual(-1e-4);
      expect(y).toBeLessThanOrEqual(10 + 1e-4);
    }
    // Labels sit inside their own square.
    expect(shapes.anchors[0]).toBeGreaterThan(0);
    expect(shapes.anchors[0]).toBeLessThan(10);
    expect(shapes.anchors[2]).toBeGreaterThan(10);
    // The quadtree's subtrees nest: each node's next lies past its children.
    const { next } = shapes.nodes;
    expect(next[0]).toBe(next.length);
    for (let n = 0; n < next.length; n++) expect(next[n]).toBeGreaterThan(n);
  });

  it('cuts areas at the antimeridian into pieces of one row, and never strokes the cut', () => {
    const shapes = prepareShapes(
      input([[[[170, -5], [-170, -5], [-170, 5], [170, 5]]]], true),
    );
    expect(shapes.pieces.length / 3).toBe(2);
    expect(shapes.pieces[0]).toBe(0);
    expect(shapes.pieces[3]).toBe(0);
    expect(shapes.bounds[0]).toBe(-180);
    expect(shapes.bounds[2]).toBe(180);
    const strips = shapes.levels.at(-1)!.strips;
    for (let k = 1; k < strips.length; k++) {
      if (strips[k] === BREAK || strips[k - 1] === BREAK) continue;
      const [ax] = at(shapes, strips[k - 1]),
        [bx] = at(shapes, strips[k]);
      expect(Math.abs(ax) === 180 && ax === bx).toBe(false);
    }
  });

  it('densifies long edges so they bend with the globe, the same points for shared edges', () => {
    const shapes = prepareShapes(input([[square(0, 0, 40)], [square(40, 0, 40)]], true));
    const last = shapes.levels.at(-1)!,
      shared = new Map<string, number>();
    // Vertices on the shared edge at x = 40, from both rows, sit at the same latitudes.
    for (let v = 0; v < shapes.vertices.length / 3; v++) {
      const [x, y] = at(shapes, v);
      if (Math.abs(x - 40) < 1e-6) shared.set(y.toFixed(4), (shared.get(y.toFixed(4)) ?? 0) + 1);
    }
    expect([...shared.values()].filter((count) => count >= 2).length).toBeGreaterThan(10);
    // Interior points keep every triangle small.
    for (let t = 0; t < last.triangles.length; t += 3) {
      const p = [0, 1, 2].map((k) => at(shapes, last.triangles[t + k]));
      for (let k = 0; k < 3; k++) {
        const [ax, ay] = p[k],
          [bx, by] = p[(k + 1) % 3];
        expect(Math.max(Math.abs(ax - bx), Math.abs(ay - by))).toBeLessThanOrEqual(10);
      }
    }
  });

  it('keeps a coarse level coarse and the finest level whole', () => {
    const ring: number[][] = [];
    for (let k = 0; k < 2000; k++) {
      const a = (k / 2000) * Math.PI * 2,
        r = 10 + Math.sin(a * 40) * 0.01;
      ring.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const shapes = prepareShapes(input([[ring]], true)),
      first = shapes.levels[0],
      last = shapes.levels.at(-1)!;
    expect(shapes.levels.length).toBeGreaterThan(2);
    expect(first.strips.length).toBeLessThan(last.strips.length / 10);
    expect(last.strips.length).toBe(2000 + 2);
    // A view zoomed out picks a coarse level; zoomed in, the finest.
    expect(levelFor(shapes, 0.2)).toBe(0);
    expect(levelFor(shapes, 1e6)).toBe(shapes.levels.length - 1);
  });

  it('draws what is in view as few ranges, and none of what lies outside', () => {
    const rows: number[][][][] = [];
    for (let i = 0; i < 64; i++) rows.push([square(-160 + (i % 8) * 40, -80 + Math.floor(i / 8) * 20, 2)]);
    const shapes = prepareShapes(input(rows, true)),
      level = shapes.levels.length - 1,
      all = visibleRanges(shapes, level, [[-180, -90, 180, 90]], 'triangles');
    expect(all).toEqual([0, shapes.levels[level].triangles.length]);
    const some = visibleRanges(shapes, level, [[-161, -81, -150, -70]], 'triangles'),
      drawn = some.reduce((n, v, i) => (i % 2 ? n + v : n), 0);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(shapes.levels[level].triangles.length / 4);
  });

  it('frames the region a camera shows, wrapping the antimeridian on a globe', () => {
    const flat = new kit.Projector(
      kit.Projector.check({ ...kit.Projector.camera, projection: 'mercator', center: [10, 20], scale: 20 }),
      viewport,
    );
    const [box] = visibleRegion(flat);
    expect(box[0]).toBeLessThan(10 - 19);
    expect(box[2]).toBeGreaterThan(10 + 19);
    const globe = new kit.Projector(
      kit.Projector.check({ ...kit.Projector.camera, projection: 'globe', center: [178, 0], scale: 40 }),
      viewport,
    );
    const region = visibleRegion(globe);
    expect(region.length).toBe(2);
  });

  it('picks the area under a point and a line near it', () => {
    const areas = prepareShapes(input([[square(0, 0, 10)], [square(10, 0, 10)]], true)),
      lines = prepareShapes(input([[[[0, 5], [20, 5]]]], false)),
      data = { tables: {}, schema: { types: {} } } as unknown as Drawn['source'],
      projector = new kit.Projector(
        kit.Projector.check({ ...kit.Projector.camera, projection: 'flat', center: [10, 5], scale: 20 }),
        viewport,
      );
    const table = { index: { source: 's', type: 'T', version: '1' }, rows: { kind: 'range', offset: 0, count: 2 } };
    (data as unknown as { tables: Record<string, unknown> }).tables.T = table;
    const drawn: Drawn[] = [
      { kind: 'area', source: data, type: 'T', shapes: areas, halfWidth: 0 },
      { kind: 'line', source: data, type: 'T', shapes: lines, halfWidth: 1 },
    ];
    const right = projector.project(15, 2);
    expect(pick(drawn, projector, [right.x, right.y], 4, 4).map((h) => [h.kind, h.row])).toEqual([
      ['area', 1],
    ]);
    const on = projector.project(5, 5.01);
    expect(pick(drawn, projector, [on.x, on.y], 4, 4)[0]).toMatchObject({ kind: 'line', row: 0 });
  });
});

describe('pack', () => {
  it('writes shapes and fields into one PMTiles archive that reads back as it was', async () => {
    const data = await geojson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'a', properties: { name: 'A', load: 0.25 }, geometry: { type: 'Polygon', coordinates: [square(0, 0, 10).concat([[0, 0]])] } },
        { type: 'Feature', id: 'b', properties: { name: 'B', load: 0.75 }, geometry: { type: 'Polygon', coordinates: [square(10, 0, 10).concat([[10, 0]])] } },
      ],
    }, { type: 'State' });
    const bytes = await pack(data, {
      areas: { State: { color: { field: 'load' }, labels: 'name' } },
      lines: { State: { points: 'rings' } },
    });
    const source = await openTiles(bytes);
    expect(source.kind).toBe('pack');
    const read = readPack((await source.tile(0, 0, 0))!, 'pack-test'),
      shapes = read.shapes.get(packKey('State', 'rings', true))!;
    expect(shapes.rows).toBe(2);
    expect(shapes.levels.length).toBeGreaterThan(0);
    expect(read.data.schema.types.State.fields).toHaveProperty('load');
    expect(read.data.schema.types.State.fields).toHaveProperty('name');
    // Lines stroking the areas' rings share their shapes, kept once.
    expect(read.shapes.size).toBe(1);
  });
});
