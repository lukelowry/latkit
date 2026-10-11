import { isFailure } from '@latkit/model';
import { describe, expect, it } from 'vitest';
import { decodeTile, properties, type FeatureSet, type TileLayer } from '../src/sources/mvt.js';
import { decodeVector } from '../src/sources/vector.js';
import { TileSet } from '../src/tiles.js';

type Bytes = number[];
type Point = [number, number];

const BYTES = 2;

/** Encodes a varint; negative values as 64-bit two's complement. */
function varint(value: number | bigint): Bytes {
  const out: Bytes = [];
  if (typeof value === 'number' && value >= 0 && value < 2 ** 31) {
    while (value >= 0x80) {
      out.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    out.push(value);
    return out;
  }
  let v = BigInt.asUintN(64, BigInt(value));
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

const key = (field: number, wire: number): Bytes => varint((field << 3) | wire);
const uint = (field: number, value: number | bigint): Bytes => [...key(field, 0), ...varint(value)];
const delimited = (field: number, payload: Bytes): Bytes => [
  ...key(field, BYTES),
  ...varint(payload.length),
  ...payload,
];
const text = (field: number, value: string): Bytes =>
  delimited(field, [...new TextEncoder().encode(value)]);
const packed = (field: number, values: readonly number[]): Bytes => {
  const payload: Bytes = [];
  for (const value of values) for (const byte of varint(value)) payload.push(byte);
  return delimited(field, payload);
};

/** A fixed-width field written through a DataView. */
function fixed(field: number, wire: 1 | 5, write: (view: DataView) => void): Bytes {
  const view = new DataView(new ArrayBuffer(wire === 1 ? 8 : 4));
  write(view);
  return [...key(field, wire), ...new Uint8Array(view.buffer)];
}

const zigzag64 = (value: bigint): bigint => (value >= 0n ? value * 2n : -value * 2n - 1n);

/** Value messages of every type, as layer field 4. */
const value = {
  string: (s: string) => delimited(4, text(1, s)),
  float: (f: number) =>
    delimited(
      4,
      fixed(2, 5, (view) => view.setFloat32(0, f, true)),
    ),
  double: (d: number) =>
    delimited(
      4,
      fixed(3, 1, (view) => view.setFloat64(0, d, true)),
    ),
  int: (n: number | bigint) => delimited(4, uint(4, n)),
  uint: (n: number | bigint) => delimited(4, uint(5, n)),
  sint: (n: number | bigint) => delimited(4, uint(6, zigzag64(BigInt(n)))),
  bool: (b: boolean) => delimited(4, uint(7, b ? 1 : 0)),
};

const command = (id: number, count: number): number => (id & 7) | (count << 3);
const zz = (n: number): number => (n << 1) ^ (n >> 31);

/** Geometry commands for absolute parts, the cursor carrying across them. */
function geometry(type: 'point' | 'line' | 'polygon', parts: readonly (readonly Point[])[]): Bytes {
  const out: Bytes = [];
  let cx = 0;
  let cy = 0;
  const to = ([x, y]: Point) => {
    out.push(zz(x - cx), zz(y - cy));
    cx = x;
    cy = y;
  };
  if (type === 'point') {
    const points = parts.flat();
    out.push(command(1, points.length));
    points.forEach(to);
    return out;
  }
  for (const part of parts) {
    out.push(command(1, 1));
    to(part[0]);
    out.push(command(2, part.length - 1));
    part.slice(1).forEach(to);
    if (type === 'polygon') out.push(command(7, 1));
  }
  return out;
}

interface FeatureSpec {
  readonly type: number;
  readonly geometry: Bytes;
  readonly id?: number | bigint;
  readonly tags?: readonly number[];
  readonly extra?: Bytes;
}

/** A feature message; its type follows its geometry to show field order does not matter. */
function feature(spec: FeatureSpec): Bytes {
  return delimited(2, [
    ...(spec.extra ?? []),
    ...(spec.id === undefined ? [] : uint(1, spec.id)),
    ...(spec.tags === undefined ? [] : packed(2, spec.tags)),
    ...packed(4, spec.geometry),
    ...uint(3, spec.type),
  ]);
}

interface LayerSpec {
  readonly name: string;
  readonly features: readonly Bytes[];
  readonly extent?: number;
  readonly keys?: readonly string[];
  readonly values?: readonly Bytes[];
  readonly extra?: Bytes;
}

/** A layer message; its features precede its tables. */
function layer(spec: LayerSpec): Bytes {
  return delimited(3, [
    ...uint(15, 2),
    ...text(1, spec.name),
    ...spec.features.flat(),
    ...(spec.keys ?? []).flatMap((k) => text(3, k)),
    ...(spec.values ?? []).flat(),
    ...(spec.extent === undefined ? [] : uint(5, spec.extent)),
    ...(spec.extra ?? []),
  ]);
}

const tile = (...layers: Bytes[]): Uint8Array => new Uint8Array(layers.flat());

/** Fields of every wire type that no MVT message defines. */
const unknown: Bytes = [
  ...uint(20, 2n ** 60n),
  ...fixed(21, 1, (view) => view.setFloat64(0, 1)),
  ...fixed(22, 5, (view) => view.setUint32(0, 7)),
  ...delimited(23, [1, 2, 3]),
];

const POINT = 1;
const LINESTRING = 2;
const POLYGON = 3;

/** A part's x, y pairs. */
function pairs(set: FeatureSet, part: number): Point[] {
  const out: Point[] = [];
  for (let i = set.parts[part]; i < set.parts[part + 1]; i++)
    out.push([set.coordinates[2 * i], set.coordinates[2 * i + 1]]);
  return out;
}

/** A ring's shoelace area in the y-down tile frame. */
function area(set: FeatureSet, part: number): number {
  const ring = pairs(set, part);
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

const only = (bytes: Uint8Array): TileLayer => {
  const layers = decodeTile(bytes);
  expect(layers).toHaveLength(1);
  return layers[0];
};

function expectMalformed(bytes: Uint8Array): void {
  let error: unknown;
  try {
    decodeTile(bytes);
  } catch (caught) {
    error = caught;
  }
  expect(isFailure(error, 'invalid-input')).toBe(true);
  expect((error as Error).message).toBe('Malformed vector tile');
}

// Square rings in the spec's winding: outer rings positive in the y-down frame, holes negative.
const outer: Point[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
const hole: Point[] = [
  [2, 2],
  [2, 8],
  [8, 8],
  [8, 2],
];
const second: Point[] = [
  [20, 0],
  [30, 0],
  [30, 10],
  [20, 10],
];

describe('decodeTile', () => {
  it('reads layers, their tables with every value type, and the default extent', () => {
    const long = 'a long street name past the ascii fast path';
    const layers = decodeTile(
      tile(
        layer({
          name: 'roads',
          keys: ['class', 'name'],
          values: [
            value.string('road'),
            value.string('Zürich'),
            value.string(long),
            value.float(1.5),
            value.double(Math.PI),
            value.int(-42),
            value.int(-1),
            value.int(-(2 ** 40)),
            value.int(2 ** 33),
            value.uint(2 ** 40 + 1),
            value.sint(-7),
            value.sint(9),
            value.sint(-(2 ** 50)),
            value.bool(true),
            value.bool(false),
            delimited(4, [...unknown, ...text(1, 'after unknown')]),
          ],
          features: [],
        }),
        layer({ name: 'water', extent: 512, features: [] }),
      ),
    );
    expect(layers.map((l) => [l.name, l.extent])).toEqual([
      ['roads', 4096],
      ['water', 512],
    ]);
    expect(layers[0].keys).toEqual(['class', 'name']);
    expect(layers[0].values).toEqual([
      'road',
      'Zürich',
      long,
      1.5,
      Math.PI,
      -42,
      -1,
      -(2 ** 40),
      2 ** 33,
      2 ** 40 + 1,
      -7,
      9,
      -(2 ** 50),
      true,
      false,
      'after unknown',
    ]);
    expect(layers[1].keys).toEqual([]);
  });

  it('returns empty sets for a layer without features and no layers for empty bytes', () => {
    expect(decodeTile(new Uint8Array())).toEqual([]);
    const { areas, lines, points } = only(tile(layer({ name: 'empty', features: [] })));
    for (const set of [areas, lines, points]) {
      expect(set.coordinates).toEqual(new Float32Array());
      expect(Array.from(set.parts)).toEqual([0]);
      expect(Array.from(set.features)).toEqual([0]);
      expect(Array.from(set.tagStarts)).toEqual([0]);
      expect(set.ids).toHaveLength(0);
    }
    expect(Array.from(areas.polygons!)).toEqual([0]);
    expect(lines.polygons).toBeUndefined();
    expect(points.polygons).toBeUndefined();
  });

  it('reads points, one part per feature, the cursor restarting per feature', () => {
    const { points } = only(
      tile(
        layer({
          name: 'pois',
          features: [
            feature({
              type: POINT,
              geometry: geometry('point', [
                [
                  [1, 2],
                  [3, 4],
                  [3, 4],
                  [-5, 10],
                ],
              ]),
            }),
            feature({ type: POINT, geometry: geometry('point', [[[100, 200]]]) }),
          ],
        }),
      ),
    );
    expect(Array.from(points.coordinates)).toEqual([1, 2, 3, 4, 3, 4, -5, 10, 100, 200]);
    expect(Array.from(points.parts)).toEqual([0, 4, 5]);
    expect(Array.from(points.features)).toEqual([0, 1, 2]);
  });

  it('reads polylines, carrying the cursor across parts and dropping short or repeated runs', () => {
    const { lines } = only(
      tile(
        layer({
          name: 'roads',
          features: [
            feature({
              type: LINESTRING,
              geometry: geometry('line', [
                [
                  [0, 0],
                  [10, 0],
                  [10, 10],
                ],
                [[20, 20]],
                [
                  [30, 30],
                  [30, 30],
                  [40, 30],
                ],
                [
                  [50, 50],
                  [50, 50],
                ],
              ]),
            }),
            feature({
              type: LINESTRING,
              geometry: [command(1, 1), zz(0), zz(0), command(2, 2), zz(5), 0, 0, zz(5), 7 | 8],
            }),
          ],
        }),
      ),
    );
    expect(pairs(lines, 0)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(pairs(lines, 1)).toEqual([
      [30, 30],
      [40, 30],
    ]);
    expect(pairs(lines, 2)).toEqual([
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 0],
    ]);
    expect(Array.from(lines.parts)).toEqual([0, 3, 5, 9]);
    expect(Array.from(lines.features)).toEqual([0, 2, 3]);
  });

  it('groups rings into polygons and normalizes the spec winding', () => {
    const { areas } = only(
      tile(
        layer({
          name: 'land',
          features: [
            feature({ type: POLYGON, geometry: geometry('polygon', [outer, hole, second]) }),
            feature({ type: POLYGON, geometry: geometry('polygon', [second]) }),
          ],
        }),
      ),
    );
    expect(Array.from(areas.parts)).toEqual([0, 4, 8, 12, 16]);
    expect(Array.from(areas.features)).toEqual([0, 3, 4]);
    expect(Array.from(areas.polygons!)).toEqual([0, 2, 3, 4]);
    expect(pairs(areas, 0)).toEqual([...outer].reverse());
    expect(pairs(areas, 1)).toEqual([...hole].reverse());
    expect([0, 1, 2, 3].map((part) => Math.sign(area(areas, part)))).toEqual([-1, 1, -1, -1]);
  });

  it('groups rings by the first ring when a tile winds them the other way', () => {
    const reversed = [outer, hole, second].map((ring) => [...ring].reverse());
    const { areas } = only(
      tile(
        layer({
          name: 'land',
          features: [feature({ type: POLYGON, geometry: geometry('polygon', reversed) })],
        }),
      ),
    );
    expect(Array.from(areas.polygons!)).toEqual([0, 2, 3]);
    expect([0, 1, 2].map((part) => pairs(areas, part))).toEqual(reversed);
    expect([0, 1, 2].map((part) => Math.sign(area(areas, part)))).toEqual([-1, 1, -1]);
  });

  it('drops degenerate rings, repeated points, closing points, and features left empty', () => {
    const triangle: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ];
    const line: Point[] = [
      [5, 5],
      [6, 6],
    ];
    const collinear: Point[] = [
      [0, 0],
      [5, 0],
      [10, 0],
    ];
    const repeated: Point[] = [
      [20, 20],
      [20, 20],
      [30, 20],
      [30, 30],
    ];
    const { areas } = only(
      tile(
        layer({
          name: 'land',
          features: [
            feature({ id: 1, type: POLYGON, geometry: geometry('polygon', [line, collinear]) }),
            feature({
              id: 2,
              type: POLYGON,
              geometry: geometry('polygon', [line, triangle, collinear, repeated]),
            }),
          ],
        }),
      ),
    );
    expect(Array.from(areas.ids)).toEqual([2]);
    expect(Array.from(areas.parts)).toEqual([0, 3, 6]);
    expect(Array.from(areas.polygons!)).toEqual([0, 1, 2]);
    expect(pairs(areas, 0)).toEqual([
      [10, 10],
      [10, 0],
      [0, 0],
    ]);
    expect(pairs(areas, 1)).toEqual([
      [30, 30],
      [30, 20],
      [20, 20],
    ]);
  });

  it('closes a ring left open by the next MoveTo or the end of the geometry', () => {
    const open = [command(1, 1), zz(0), zz(0), command(2, 2), zz(10), 0, 0, zz(10)];
    const { areas } = only(
      tile(
        layer({
          name: 'land',
          features: [
            feature({
              type: POLYGON,
              geometry: [...open, ...open.map((v, i) => (i === 1 ? zz(20) : v))],
            }),
          ],
        }),
      ),
    );
    expect(Array.from(areas.parts)).toEqual([0, 3, 6]);
    expect(pairs(areas, 1)).toEqual([
      [40, 20],
      [40, 10],
      [30, 10],
    ]);
    expect(Array.from(areas.polygons!)).toEqual([0, 1, 2]);
  });

  it('reads ids and tags, and lists properties', () => {
    const roads = only(
      tile(
        layer({
          name: 'roads',
          keys: ['class', 'lanes', '__proto__'],
          values: [value.string('primary'), value.uint(2), value.bool(true), value.int(4)],
          features: [
            feature({
              id: 7,
              type: LINESTRING,
              geometry: geometry('line', [outer]),
              tags: [0, 0, 1, 3],
            }),
            feature({ type: LINESTRING, geometry: geometry('line', [hole]) }),
            feature({
              id: 2n ** 40n,
              type: LINESTRING,
              geometry: geometry('line', [second]),
              tags: [2, 2, 0, 1],
            }),
          ],
        }),
      ),
    );
    const { lines } = roads;
    expect(Array.from(lines.ids)).toEqual([7, NaN, 2 ** 40]);
    expect(Array.from(lines.tags)).toEqual([0, 0, 1, 3, 2, 2, 0, 1]);
    expect(Array.from(lines.tagStarts)).toEqual([0, 2, 2, 4]);
    expect(properties(roads, lines, 0)).toEqual({ class: 'primary', lanes: 4 });
    expect(properties(roads, lines, 1)).toEqual({});
    const third = properties(roads, lines, 2);
    expect(Object.getPrototypeOf(third)).toBe(Object.prototype);
    expect(Object.hasOwn(third, '__proto__')).toBe(true);
    expect(third.class).toBe(2);
  });

  it('files features by geometry, skipping unknown types and unknown fields', () => {
    const bytes = new Uint8Array([
      ...unknown,
      ...layer({
        name: 'mixed',
        keys: ['kind'],
        values: [value.string('x')],
        extra: unknown,
        features: [
          feature({ type: 0, geometry: geometry('point', [[[9, 9]]]) }),
          feature({ type: POINT, geometry: geometry('point', [[[1, 1]]]), extra: unknown }),
          feature({ type: 4, geometry: geometry('point', [[[9, 9]]]) }),
          feature({ type: LINESTRING, geometry: geometry('line', [outer]), tags: [0, 0] }),
          feature({ type: POLYGON, geometry: geometry('polygon', [outer]) }),
        ],
      }),
      ...layer({
        name: 'next',
        features: [feature({ type: LINESTRING, geometry: geometry('line', [hole]) })],
      }),
    ]);
    const [mixed, next] = decodeTile(bytes);
    expect(Array.from(mixed.points.coordinates)).toEqual([1, 1]);
    expect(mixed.lines.features).toHaveLength(2);
    expect(mixed.areas.features).toHaveLength(2);
    expect(properties(mixed, mixed.lines, 0)).toEqual({ kind: 'x' });
    expect(pairs(next.lines, 0)).toEqual(hole);
    expect(next.lines.features).toHaveLength(2);
    expect(next.points.features).toHaveLength(1);
  });

  it('decodes a tile inside a larger buffer', () => {
    const bytes = tile(
      layer({
        name: 'offset',
        values: [value.float(0.25), value.double(-2.5)],
        features: [feature({ type: POINT, geometry: geometry('point', [[[3, 4]]]) })],
      }),
    );
    const buffer = new Uint8Array(bytes.length + 5);
    buffer.set(bytes, 3);
    const decoded = only(buffer.subarray(3, 3 + bytes.length));
    expect(decoded.values).toEqual([0.25, -2.5]);
    expect(Array.from(decoded.points.coordinates)).toEqual([3, 4]);
  });

  it('throws on malformed input', () => {
    const lineTile = (geometryBytes: Bytes, tags?: number[]) =>
      tile(
        layer({
          name: 'bad',
          keys: ['k'],
          values: [value.bool(true)],
          features: [feature({ type: LINESTRING, geometry: geometryBytes, tags })],
        }),
      );
    const line = geometry('line', [outer]);
    expectMalformed(new Uint8Array([0x80]));
    expectMalformed(new Uint8Array([0x1a, 0x80]));
    expectMalformed(new Uint8Array([0x1a, 0x05, 0x0a]));
    expectMalformed(new Uint8Array([0x08, ...new Array<number>(11).fill(0xff)]));
    expectMalformed(new Uint8Array([0x0b]));
    expectMalformed(new Uint8Array(delimited(3, [...key(4, 1), 0, 0, 0])));
    expectMalformed(
      new Uint8Array(layer({ name: 'bad', values: [delimited(4, [])], features: [] })),
    );
    expectMalformed(lineTile([command(1, 2), zz(1), zz(1)]));
    expectMalformed(lineTile([command(1, 1), zz(1)]));
    expectMalformed(lineTile([command(3, 1), 0, 0]));
    expectMalformed(lineTile([command(2, 1), zz(1), zz(1)]));
    expectMalformed(lineTile(line, [1, 0]));
    expectMalformed(lineTile(line, [0, 1]));
    expectMalformed(lineTile(line, [0]));
    expect(() => decodeTile(lineTile(line, [0, 0]))).not.toThrow();
  });

  it('decodes a large tile in linear time', () => {
    const path: Point[] = [];
    for (let i = 0; i < 100_000; i++) path.push([i % 4096, (i * 7) % 4096]);
    const features = [feature({ id: 1, type: LINESTRING, geometry: geometry('line', [path]) })];
    for (let i = 0; i < 20_000; i++) {
      const x = i % 4000;
      features.push(
        feature({
          id: i,
          type: i % 2 ? LINESTRING : POLYGON,
          geometry: geometry(i % 2 ? 'line' : 'polygon', [
            [
              [x, 0],
              [x + 10, 0],
              [x + 10, 10],
              [x, 10],
            ],
          ]),
          tags: [0, i % 2],
        }),
      );
    }
    const bytes = tile(
      layer({ name: 'big', keys: ['k'], values: [value.uint(0), value.uint(1)], features }),
    );
    decodeTile(bytes);
    const start = performance.now();
    const { lines, areas } = only(bytes);
    const elapsed = performance.now() - start;
    expect(lines.features).toHaveLength(10_001 + 1);
    expect(areas.features).toHaveLength(10_000 + 1);
    expect(lines.parts[1]).toBe(100_000);
    expect(lines.coordinates).toHaveLength(2 * (100_000 + 4 * 10_000));
    expect(pairs(lines, 0)[99_999]).toEqual(path[99_999]);
    expect(areas.coordinates).toHaveLength(2 * 4 * 10_000);
    expect(area(areas, 9_999)).toBe(-100);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('decodeVector', () => {
  it('gives the ids of features that each carry a distinct one, for the tiles to number', () => {
    const square = geometry('polygon', [outer]);
    const decode = (x: number, ids: readonly (number | bigint | undefined)[]) =>
      decodeVector({
        bytes: tile(
          layer({
            name: 'state',
            features: ids.map((id) => feature({ id, type: POLYGON, geometry: square })),
          }),
        ),
        z: 1,
        x,
        y: 0,
        layers: [{ name: 'state', rings: true, lines: false }],
        source: `tiles/1/${x}/0`,
      }).tile;
    const west = decode(0, [7, 2n ** 40n]),
      east = decode(1, [2n ** 40n]);
    expect(west.layers[0].ids).toEqual(Float64Array.of(7, 2 ** 40));
    expect(east.layers[0].ids).toEqual(Float64Array.of(2 ** 40));
    expect(west.batches[0].index).toEqual({ source: 'tiles/1/0/0', type: 'state', version: '1' });
    // Tiles number each id once, whichever tile holds it first.
    const tiles = new TileSet(new Uint8Array(0), {});
    tiles.info.catch(() => {});
    expect(tiles.rowsOf(west.layers[0].ids!)).toEqual(Uint32Array.of(0, 1));
    expect(tiles.rowsOf(east.layers[0].ids!)).toEqual(Uint32Array.of(1));
    // Without ids, or with one repeated, a tile's features are its own.
    for (const ids of [
      [undefined, 3],
      [4, 4],
    ])
      expect(decode(1, ids).layers[0].ids).toBeUndefined();
  });
});
