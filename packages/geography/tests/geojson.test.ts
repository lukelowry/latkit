import { describe, expect, it, vi } from 'vitest';
import {
  bitAt,
  createReader,
  isFailure,
  rowCount,
  textAt,
  validateBatch,
  type Column,
  type Data,
} from '@latkit/model';
import { geojsonBatches } from '../src/sources/geojson.js';
import { geojson } from '../src/geojson.js';
import type { Geography } from '../src/geography.js';
type Ring = number[][];

/** A cell as plain values: numbers, booleans, text, and nested arrays; null when absent. */
function valueAt(column: Column, row: number): unknown {
  const at = column.offset + row;
  if (!bitAt(column.validity, at)) return null;
  switch (column.kind) {
    case 'numeric':
    case 'reference':
      return column.values[at];
    case 'boolean':
      return bitAt(column.values, at);
    case 'text':
      return textAt(column, row);
    case 'vector': {
      const start = column.values.offset + at * column.size;
      return Array.from(column.values.values.subarray(start, start + column.size));
    }
    case 'list': {
      const items: unknown[] = [];
      for (let i = column.offsets[at]; i < column.offsets[at + 1]; i++)
        items.push(valueAt(column.values, i));
      return items;
    }
  }
}

interface Rows {
  readonly ids: (string | null)[];
  readonly fields: Record<string, unknown[]>;
}

/** Every row of `type`, read back through the model. */
async function rowsOf(data: Data, type: string): Promise<Rows> {
  const reader = createReader();
  const scope = reader.open();
  try {
    const select = Object.keys(data.schema.types[type].fields);
    const ids: (string | null)[] = [];
    const fields: Record<string, unknown[]> = Object.fromEntries(select.map((name) => [name, []]));
    for await (const block of scope.read(data, { kind: 'rows', from: type, select, ids: true })) {
      for (let i = 0; i < rowCount(block.rows); i++) {
        ids.push(textAt(block.ids!, i));
        for (const name of select) fields[name].push(valueAt(block.columns[name], i));
      }
    }
    return { ids, fields };
  } finally {
    scope.close();
    reader.destroy();
  }
}

function feature(
  geometry: unknown,
  properties: Record<string, unknown> | null = {},
  id?: unknown,
): Record<string, unknown> {
  return { type: 'Feature', geometry, properties, ...(id === undefined ? {} : { id }) };
}

function collection(...features: unknown[]): Record<string, unknown> {
  return { type: 'FeatureCollection', features };
}

/** Shoelace area, positive when counter-clockwise. */
function area(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i],
      [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/** A closed square ring from (x, y) of side `size`, counter-clockwise unless `clockwise`. */
function square(x: number, y: number, size: number, clockwise = false): Ring {
  const ring = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];
  if (clockwise) ring.reverse();
  return [...ring, ring[0]];
}

/** The error `run` throws; fails the test when it throws none. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure.');
}

async function expectNotGeoJson(value: unknown, options?: Geography.GeoJsonOptions): Promise<void> {
  const error = thrown(() => geojsonBatches(value, options));
  expect(isFailure(error, 'invalid-input')).toBe(true);
  expect((error as Error).message).toMatch(/^Not GeoJSON: /);
  await expect(geojson(value as object, options)).rejects.toThrow(/^Not GeoJSON: /);
}

describe('geojson polygons', () => {
  it('drops closing points and winds outlines counter-clockwise and holes clockwise', async () => {
    const data = await geojson(
      collection(
        feature({
          type: 'Polygon',
          coordinates: [square(0, 0, 4, true), square(1, 1, 1, false)],
        }),
        feature({
          type: 'Polygon',
          coordinates: [square(10, 0, 4, false), square(11, 1, 1, true)],
        }),
      ),
    );
    const { fields } = await rowsOf(data, 'Feature');
    const [first, second] = fields.rings as Ring[][];
    expect(first).toEqual([
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      [
        [1, 2],
        [2, 2],
        [2, 1],
        [1, 1],
      ],
    ]);
    // Already wound correctly: kept in order, closing point dropped.
    expect(second).toEqual([square(10, 0, 4).slice(0, 4), square(11, 1, 1, true).slice(0, 4)]);
    for (const rings of [first, second]) {
      expect(area(rings[0])).toBeGreaterThan(0);
      expect(area(rings[1])).toBeLessThan(0);
    }
    expect(data.schema.types.Feature.fields.rings).toEqual({
      type: {
        kind: 'list',
        items: { kind: 'list', items: { kind: 'vector', items: 'float64', size: 2 } },
      },
      geographic: true,
    });
  });

  it('puts every ring of a MultiPolygon in one list, normalizing either winding', async () => {
    const data = await geojson(
      feature({
        type: 'MultiPolygon',
        coordinates: [
          [square(0, 0, 10, true), square(2, 2, 2, false), square(6, 6, 2, true)],
          [square(20, 0, 5, false), square(21, 1, 1, false)],
        ],
      }),
    );
    const rings = (await rowsOf(data, 'Feature')).fields.rings[0] as Ring[];
    expect(rings.map((ring) => Math.sign(area(ring)))).toEqual([1, -1, -1, 1, -1]);
    expect(rings.map((ring) => Math.abs(area(ring)))).toEqual([100, 4, 4, 25, 1]);
    expect(rings.every((ring) => ring.length === 4)).toBe(true);
  });

  it('drops degenerate rings, and a polygon whose outline is degenerate', async () => {
    const twoDistinct = [
      [0, 0],
      [1, 1],
      [0, 0],
      [1, 1],
      [0, 0],
    ];
    const { batches, schema } = geojsonBatches(
      collection(
        feature({ type: 'Polygon', coordinates: [twoDistinct] }),
        feature({
          type: 'Polygon',
          coordinates: [
            square(0, 0, 2),
            [
              [0, 0],
              [1, 1],
              [0, 0],
            ],
            [[5, 5]],
            [],
          ],
        }),
        feature({ type: 'Polygon', coordinates: [twoDistinct, square(0, 0, 1, true)] }),
        feature({
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
          ],
        }),
        feature({
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 0],
              [1, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        }),
        feature({ type: 'Polygon', coordinates: [] }),
      ),
    );
    const rings = batches[0].columns.rings;
    expect([0, 1, 2, 3, 4, 5].map((row) => valueAt(rings, row))).toEqual([
      null,
      [square(0, 0, 2).slice(0, 4)],
      null,
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ],
      [
        [
          [0, 0],
          [0, 0],
          [1, 0],
          [1, 0],
          [1, 1],
        ],
      ],
      null,
    ]);
    expect(schema.types.Feature.fields.rings.nullable).toBe(true);
  });

  it('gives no rings field when no polygon keeps a ring', () => {
    const { schema, batches } = geojsonBatches(
      feature({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }),
    );
    expect(schema.types.Feature.fields).toEqual({});
    expect(rowCount(batches[0].rows)).toBe(1);
  });
});

describe('geojson lines and points', () => {
  it('keeps polylines of two points or more as points', async () => {
    const data = await geojson(
      collection(
        feature({
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
            [2, 0],
          ],
        }),
        feature({
          type: 'MultiLineString',
          coordinates: [
            [[9, 9]],
            [
              [3, 3],
              [4, 4],
            ],
            [
              [5, 5],
              [5, 5],
            ],
          ],
        }),
        feature({ type: 'LineString', coordinates: [[7, 7]] }),
      ),
    );
    const { fields } = await rowsOf(data, 'Feature');
    expect(fields.points).toEqual([
      [
        [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      ],
      [
        [
          [3, 3],
          [4, 4],
        ],
        [
          [5, 5],
          [5, 5],
        ],
      ],
      null,
    ]);
    expect(Object.keys(data.schema.types.Feature.fields)).toEqual(['points']);
    expect(data.schema.types.Feature.fields.points).toMatchObject({
      geographic: true,
      nullable: true,
    });
  });

  it('takes a position from a Point, or the first of a MultiPoint, ignoring altitude', async () => {
    const data = await geojson(
      collection(
        feature({ type: 'Point', coordinates: [10, 20, 300] }),
        feature({
          type: 'MultiPoint',
          coordinates: [
            [1, 2],
            [3, 4],
          ],
        }),
        feature({ type: 'Point', coordinates: [] }),
        feature({ type: 'MultiPoint', coordinates: [] }),
      ),
    );
    const { fields } = await rowsOf(data, 'Feature');
    expect(fields.position).toEqual([[10, 20], [1, 2], null, null]);
    expect(data.schema.types.Feature.fields).toEqual({
      position: {
        type: { kind: 'vector', items: 'float64', size: 2 },
        geographic: true,
        nullable: true,
      },
    });
  });

  it('wraps longitudes and clamps latitudes', async () => {
    const data = await geojson(
      collection(
        feature({ type: 'Point', coordinates: [190, 95] }),
        feature({ type: 'Point', coordinates: [-190, -100] }),
        feature({ type: 'Point', coordinates: [180, 90] }),
        feature({ type: 'Point', coordinates: [-180, -90] }),
        feature({ type: 'Point', coordinates: [540, 0] }),
      ),
    );
    expect((await rowsOf(data, 'Feature')).fields.position).toEqual([
      [-170, 90],
      [170, -90],
      [180, 90],
      [-180, -90],
      [-180, 0],
    ]);
  });
});

describe('geojson geometry', () => {
  it('lets a GeometryCollection fill every shape field of one row', async () => {
    const data = await geojson(
      feature({
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', coordinates: [square(0, 0, 1)] },
          {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          { type: 'Point', coordinates: [5, 6] },
          {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Point', coordinates: [7, 8] },
              { type: 'MultiPolygon', coordinates: [[square(2, 2, 1, true)]] },
            ],
          },
        ],
      }),
    );
    const { fields } = await rowsOf(data, 'Feature');
    expect(fields.position).toEqual([[5, 6]]);
    expect(fields.points).toEqual([
      [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    ]);
    expect(fields.rings).toEqual([[square(0, 0, 1).slice(0, 4), square(2, 2, 1).slice(0, 4)]]);
    expect(Object.keys(data.schema.types.Feature.fields)).toEqual(['rings', 'points', 'position']);
    expect(data.schema.types.Feature.fields.rings.nullable).toBeUndefined();
  });

  it('gives a feature without geometry a row of nulls', async () => {
    const data = await geojson(
      collection(
        feature({ type: 'Point', coordinates: [1, 2] }),
        feature(null, { name: 'nowhere' }),
        { type: 'Feature', properties: null },
      ),
    );
    const rows = await rowsOf(data, 'Feature');
    expect(rows.ids).toEqual(['Feature/0', 'Feature/1', 'Feature/2']);
    expect(rows.fields.position).toEqual([[1, 2], null, null]);
    expect(rows.fields.name).toEqual([null, 'nowhere', null]);
  });

  it('reads a bare geometry, a single Feature, and text', async () => {
    const bare = await rowsOf(
      await geojson({ type: 'Polygon', coordinates: [square(0, 0, 1)] }),
      'Feature',
    );
    expect(bare.ids).toEqual(['Feature/0']);
    expect(bare.fields.rings).toEqual([[square(0, 0, 1).slice(0, 4)]]);

    const single = await rowsOf(
      await geojson(feature({ type: 'Point', coordinates: [1, 2] }, { a: 1 }, 'one')),
      'Feature',
    );
    expect(single).toEqual({ ids: ['one'], fields: { position: [[1, 2]], a: [1] } });

    const text = await geojson(
      new Blob([JSON.stringify(collection(feature({ type: 'Point', coordinates: [3, 4] })))]),
      { type: 'Place' },
    );
    expect((await rowsOf(text, 'Place')).fields.position).toEqual([[3, 4]]);
  });

  it('reads bytes, a view of them, a Blob, and a URL alike, gzipped or not, and stops when aborted', async () => {
    const json = JSON.stringify(collection(feature({ type: 'Point', coordinates: [5, 6] }))),
      bytes = new TextEncoder().encode(json),
      gzipped = new Uint8Array(
        await new Response(
          new Blob([json]).stream().pipeThrough(new CompressionStream('gzip')),
        ).arrayBuffer(),
      ),
      padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    vi.stubGlobal('fetch', (url: string | URL) =>
      Promise.resolve(
        String(url) === 'https://maps.test/places.geojson'
          ? new Response(json)
          : String(url) === 'https://maps.test/places.geojson.gz'
            ? new Response(gzipped.slice())
            : new Response('', { status: 404 }),
      ),
    );
    try {
      for (const from of [
        bytes.buffer,
        padded.subarray(4, 4 + bytes.length),
        new Blob([json]),
        new URL('https://maps.test/places.geojson'),
        'https://maps.test/places.geojson',
        'https://maps.test/places.geojson.gz',
        gzipped.slice(),
        new Blob([gzipped]),
      ]) {
        const data = await geojson(from, { type: 'Place' });
        expect((await rowsOf(data, 'Place')).fields.position).toEqual([[5, 6]]);
      }
      // Bytes the caller holds stay theirs.
      expect(bytes.byteLength).toBe(json.length);
      // A type named by a function parses bytes on the page.
      const named = await geojson(bytes, { type: () => 'Named' });
      expect(Object.keys(named.schema.types)).toEqual(['Named']);
      const unzipped = await geojson(gzipped.slice(), { type: () => 'Named' });
      expect((await rowsOf(unzipped, 'Named')).fields.position).toEqual([[5, 6]]);
      await expect(geojson(new URL('https://maps.test/missing.geojson'))).rejects.toMatchObject({
        code: 'io',
      });
      await expect(geojson(bytes, { signal: AbortSignal.abort() })).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('builds plain typed columns that validate against the schema', () => {
    const { schema, batches } = geojsonBatches(
      collection(
        feature({ type: 'Polygon', coordinates: [square(0, 0, 1)] }, { n: 1, s: 'a', b: true }),
        feature(null, { n: null }),
        feature(
          {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          { s: 2 },
        ),
        feature({ type: 'Point', coordinates: [1, 1] }, { b: false }),
      ),
    );
    expect(batches).toHaveLength(1);
    for (const batch of batches) expect(validateBatch(schema, batch)).toEqual([]);
    const rings = batches[0].columns.rings as Column.List;
    const paths = rings.values as Column.List;
    const positions = paths.values as Column.Vector;
    expect(rings.offsets).toBeInstanceOf(Int32Array);
    expect(paths.offsets).toBeInstanceOf(Int32Array);
    expect(positions.values.values).toBeInstanceOf(Float64Array);
    expect(Array.from(rings.offsets)).toEqual([0, 1, 1, 1, 1]);
    expect(positions.values.values).toHaveLength(8);
  });
});

describe('geojson properties', () => {
  it('infers a type per property and stores null for missing values', async () => {
    const data = await geojson(
      collection(
        feature(null, {
          name: 'a',
          pop: 10,
          flag: true,
          mixed: 'x',
          object: { a: 1 },
          rings: 'skipped',
          nothing: null,
        }),
        feature(null, { name: 'b', pop: 2.5, flag: false, mixed: 3, object: [1, 2] }),
        feature(null, { name: null, pop: null, flag: true, mixed: true, rings: 4 }),
        feature({ type: 'Polygon', coordinates: [square(0, 0, 1)] }, { flag: false, mixed: false }),
      ),
    );
    const fields = data.schema.types.Feature.fields;
    expect(Object.keys(fields)).toEqual(['rings', 'name', 'pop', 'flag', 'mixed', 'object']);
    expect(fields.name).toEqual({ type: 'text', nullable: true });
    expect(fields.pop).toEqual({ type: 'float64', nullable: true });
    expect(fields.flag).toEqual({ type: 'boolean' });
    expect(fields.mixed).toEqual({ type: 'text' });
    expect(fields.object).toEqual({ type: 'text', nullable: true });
    const rows = await rowsOf(data, 'Feature');
    expect(rows.fields.name).toEqual(['a', 'b', null, null]);
    expect(rows.fields.pop).toEqual([10, 2.5, null, null]);
    expect(rows.fields.flag).toEqual([true, false, true, false]);
    expect(rows.fields.mixed).toEqual(['x', '3', 'true', 'false']);
    expect(rows.fields.object).toEqual(['{"a":1}', '[1,2]', null, null]);
    expect(rows.fields.rings).toEqual([null, null, null, [square(0, 0, 1).slice(0, 4)]]);
  });

  it('reads only own properties', async () => {
    const data = await geojson(
      collection(feature(null, { constructor: 'c' }), feature(null, { other: 1 })),
    );
    expect((await rowsOf(data, 'Feature')).fields.constructor).toEqual(['c', null]);
  });
});

describe('geojson ids and types', () => {
  it('takes the feature id, else the type and place, numbering duplicates', async () => {
    const point = { type: 'Point', coordinates: [0, 0] };
    const data = await geojson(
      collection(
        feature(point, {}, 'x'),
        feature(point, {}, 7),
        feature(point),
        feature(point, {}, ''),
        feature(point, {}, 'x'),
        feature(point, {}, 'x#3'),
        feature(point, {}, 'x'),
        feature(point, {}, 'Feature/2'),
      ),
    );
    expect((await rowsOf(data, 'Feature')).ids).toEqual([
      'x',
      '7',
      'Feature/2',
      'Feature/3',
      'x#2',
      'x#3',
      'x#4',
      'Feature/2#2',
    ]);
  });

  it('takes ids from a property, falling back to the feature id', async () => {
    const data = await geojson(
      collection(
        feature(null, { code: 'A' }, 'ignored'),
        feature(null, { code: 12 }),
        feature(null, { code: null }, 'own'),
        feature(null, {}),
        feature(null, { code: 'A' }),
      ),
      { id: 'code' },
    );
    const rows = await rowsOf(data, 'Feature');
    expect(rows.ids).toEqual(['A', '12', 'own', 'Feature/3', 'A#2']);
    expect(rows.fields.code).toEqual(['A', '12', null, null, 'A']);
  });

  it('splits features into types by a function of their properties', async () => {
    const data = await geojson(
      collection(
        feature(
          {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          { kind: 'road', lanes: 2 },
        ),
        feature({ type: 'Polygon', coordinates: [square(0, 0, 1)] }, { kind: 'zone', price: 3 }),
        feature(
          {
            type: 'LineString',
            coordinates: [
              [2, 2],
              [3, 3],
            ],
          },
          { kind: 'road' },
        ),
      ),
      { type: (properties) => (properties.kind === 'road' ? 'Road' : 'Zone'), source: 'world' },
    );
    expect(Object.keys(data.schema.types)).toEqual(['Road', 'Zone']);
    expect(Object.keys(data.schema.types.Road.fields)).toEqual(['points', 'kind', 'lanes']);
    expect(Object.keys(data.schema.types.Zone.fields)).toEqual(['rings', 'kind', 'price']);
    expect(data.tables.Road.index).toEqual({ source: 'world', type: 'Road', version: '1' });
    const roads = await rowsOf(data, 'Road');
    expect(roads.ids).toEqual(['Road/0', 'Road/1']);
    expect(roads.fields.lanes).toEqual([2, null]);
    expect((await rowsOf(data, 'Zone')).ids).toEqual(['Zone/0']);
  });

  it('numbers rows under a fresh source by default', () => {
    const value = feature({ type: 'Point', coordinates: [0, 0] });
    const a = geojsonBatches(value).batches[0].index;
    const b = geojsonBatches(value).batches[0].index;
    expect(a.source).not.toBe(b.source);
    expect(a.source).toBeTruthy();
    expect(a).toMatchObject({ type: 'Feature', version: '1' });
  });

  it('gives an empty FeatureCollection no types', async () => {
    const data = await geojson(collection());
    expect(data.schema.types).toEqual({});
    expect(data.tables).toEqual({});
  });
});

describe('geojson errors', () => {
  it('rejects values that are not GeoJSON', async () => {
    await expectNotGeoJson(42);
    await expectNotGeoJson([]);
    await expectNotGeoJson({});
    await expectNotGeoJson({ type: 'Topology' });
    await expectNotGeoJson({ type: 'FeatureCollection' });
    await expectNotGeoJson(collection({ type: 'Point', coordinates: [0, 0] }));
    await expectNotGeoJson(feature({ type: 'Circle', coordinates: [0, 0] }));
    await expectNotGeoJson(feature({ type: 'Point', coordinates: [0, 0] }, [] as never));
    await expectNotGeoJson(feature('Point'));
    await expect(geojson(new Blob(['{"type": ']))).rejects.toThrow(/^Not GeoJSON: /);
  });

  it('rejects positions that are not finite', async () => {
    await expectNotGeoJson({ type: 'Point', coordinates: [Number.NaN, 0] });
    await expectNotGeoJson({ type: 'Point', coordinates: ['1', 0] });
    await expectNotGeoJson({ type: 'Point', coordinates: [1] });
    await expectNotGeoJson({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [Infinity, 1],
      ],
    });
    await expectNotGeoJson({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], null]] });
    await expectNotGeoJson({ type: 'Polygon', coordinates: 'none' });
    await expectNotGeoJson({
      type: 'MultiPolygon',
      coordinates: [[square(0, 0, 1), [[0, -Infinity]]]],
    });
  });

  it('rejects a type that is not a nonempty string', () => {
    const value = feature({ type: 'Point', coordinates: [0, 0] });
    expect(
      isFailure(
        thrown(() => geojsonBatches(value, { type: () => '' })),
        'invalid-input',
      ),
    ).toBe(true);
  });
});

describe('geojson scale', () => {
  it('converts 200k positions quickly', async () => {
    const features: unknown[] = [];
    for (let i = 0; i < 100_000; i++)
      features.push(
        feature(
          { type: 'Point', coordinates: [(i % 360) - 180, (i % 180) - 90] },
          { n: i, name: 'p' },
        ),
      );
    for (let i = 0; i < 1000; i++) {
      const ring: Ring = [];
      for (let k = 0; k < 100; k++) {
        const angle = (k / 100) * 2 * Math.PI;
        ring.push([Math.cos(angle), Math.sin(angle)]);
      }
      ring.push(ring[0]);
      features.push(feature({ type: 'Polygon', coordinates: [ring] }, { n: i, zone: true }));
    }
    const value = collection(...features);
    const start = performance.now();
    const { schema, batches } = geojsonBatches(value);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1500);
    expect(rowCount(batches[0].rows)).toBe(101_000);
    const rings = batches[0].columns.rings as Column.List;
    expect(((rings.values as Column.List).values as Column.Vector).length).toBe(100_000);
    expect(schema.types.Feature.fields.zone).toEqual({ type: 'boolean', nullable: true });
    const data = await geojson(value);
    expect(Object.keys(data.tables)).toEqual(['Feature']);
  });
});
