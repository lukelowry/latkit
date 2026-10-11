import { isFailure } from '@latkit/model';
import { describe, expect, it } from 'vitest';
import {
  cutLines,
  cutRings,
  labelPoint,
  polygonsOf,
  ringArea,
  simplificationAreas,
  simplified,
  triangulate,
  type Parts,
} from '../src/prepare/geometry.js';

type Point = readonly [number, number];

function partsOf(parts: readonly (readonly Point[])[]): Parts {
  const xy: number[] = [],
    starts = [0];
  for (const part of parts) {
    for (const [x, y] of part) xy.push(x, y);
    starts.push(xy.length / 2);
  }
  return { coordinates: Float64Array.from(xy), parts: Uint32Array.from(starts) };
}

function pointsOf(parts: Parts): Point[][] {
  const out: Point[][] = [];
  for (let p = 0; p + 1 < parts.parts.length; p++) {
    const part: Point[] = [];
    for (let i = parts.parts[p]; i < parts.parts[p + 1]; i++)
      part.push([parts.coordinates[2 * i], parts.coordinates[2 * i + 1]]);
    out.push(part);
  }
  return out;
}

function areasOf(parts: Parts): number[] {
  return Array.from({ length: parts.parts.length - 1 }, (_, p) => ringArea(parts, p));
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isFailure(error) ? error.code : 'not a failure';
  }
  return undefined;
}

/** A deterministic sequence in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A wobbly counter-clockwise ring of `n` points around (cx, cy). */
function wobblyRing(n: number, cx: number, cy: number, radius: number, seed: number): Point[] {
  const next = random(seed);
  return Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n,
      r = radius * (0.8 + 0.4 * next());
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const;
  });
}

describe('cutLines', () => {
  it('cuts a line crossing eastward at +180 and resumes at −180', () => {
    const cut = cutLines(
      partsOf([
        [
          [170, 0],
          [-170, 10],
        ],
      ]),
    );
    expect(pointsOf(cut)).toEqual([
      [
        [170, 0],
        [180, 5],
      ],
      [
        [-180, 5],
        [-170, 10],
      ],
    ]);
  });

  it('cuts a line crossing westward at −180 and resumes at +180', () => {
    const cut = cutLines(
      partsOf([
        [
          [-170, 0],
          [170, 10],
        ],
      ]),
    );
    expect(pointsOf(cut)).toEqual([
      [
        [-170, 0],
        [-180, 5],
      ],
      [
        [180, 5],
        [170, 10],
      ],
    ]);
  });

  it('cuts at every crossing and leaves other lines as they are', () => {
    const lines = partsOf([
      [
        [0, 0],
        [10, 10],
      ],
      [
        [170, 0],
        [-170, 0],
        [-175, 5],
        [175, 5],
        [170, 10],
        [-170, 10],
      ],
    ]);
    expect(pointsOf(cutLines(lines))).toEqual([
      [
        [0, 0],
        [10, 10],
      ],
      [
        [170, 0],
        [180, 0],
      ],
      [
        [-180, 0],
        [-170, 0],
        [-175, 5],
        [-180, 5],
      ],
      [
        [180, 5],
        [175, 5],
        [170, 10],
        [180, 10],
      ],
      [
        [-180, 10],
        [-170, 10],
      ],
    ]);
  });

  it('drops the empty piece when a line starts on the antimeridian', () => {
    const cut = cutLines(
      partsOf([
        [
          [180, 0],
          [-170, 0],
          [-160, 0],
        ],
      ]),
    );
    expect(pointsOf(cut)).toEqual([
      [
        [-180, 0],
        [-170, 0],
        [-160, 0],
      ],
    ]);
  });
});

describe('cutRings', () => {
  const box: Point[] = [
    [170, 10],
    [-170, 10],
    [-170, 20],
    [170, 20],
  ];

  it('returns rings that do not cross as they are', () => {
    const rings = partsOf([
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ]);
    const cut = cutRings(rings);
    expect(Array.from(cut.coordinates)).toEqual(Array.from(rings.coordinates));
    expect(Array.from(cut.parts)).toEqual(Array.from(rings.parts));
  });

  it('cuts a box across ±180 into one piece on each side, closed along the antimeridian', () => {
    const cut = cutRings(partsOf([box]));
    expect(pointsOf(cut)).toEqual([
      [
        [-180, 10],
        [-170, 10],
        [-170, 20],
        [-180, 20],
      ],
      [
        [180, 20],
        [170, 20],
        [170, 10],
        [180, 10],
      ],
    ]);
    expect(areasOf(cut)).toEqual([100, 100]);
  });

  it('keeps the winding of a clockwise ring', () => {
    const cut = cutRings(partsOf([[...box].reverse()]));
    expect(areasOf(cut)).toEqual([-100, -100]);
  });

  it('cuts a ring crossing four times into three pieces', () => {
    // A C shape spanning 170°..190°, its notch 175°..190° × 10..20 opening east across ±180.
    const shape: Point[] = [
      [170, 0],
      [-170, 0],
      [-170, 10],
      [175, 10],
      [175, 20],
      [-170, 20],
      [-170, 30],
      [170, 30],
    ];
    const cut = cutRings(partsOf([shape]));
    const pieces = pointsOf(cut);
    expect(pieces).toHaveLength(3);
    expect(areasOf(cut).sort((a, b) => a - b)).toEqual([100, 100, 250]);
    for (const piece of pieces) {
      const xs = piece.map(([x]) => x);
      expect(xs.every((x) => x >= 170) || xs.every((x) => x <= -170)).toBe(true);
    }
  });

  it('closes a ring around the south pole along −90', () => {
    // Westward around the south pole: counter-clockwise once closed along the pole.
    const antarctica: Point[] = [
      [170, -70],
      [90, -75],
      [0, -70],
      [-90, -75],
      [-170, -70],
    ];
    const cut = cutRings(partsOf([antarctica]));
    expect(pointsOf(cut)).toEqual([
      [
        [180, -70],
        [170, -70],
        [90, -75],
        [0, -70],
        [-90, -75],
        [-170, -70],
        [-180, -70],
        [-180, -90],
        [180, -90],
      ],
    ]);
    expect(ringArea(cut, 0)).toBeGreaterThan(0);
  });

  it('closes a ring spanning −180..180 monotonically along the nearer pole, keeping its winding', () => {
    const eastward: Point[] = [
      [-180, -70],
      [-90, -75],
      [0, -70],
      [90, -75],
      [180, -70],
    ];
    const cut = cutRings(partsOf([eastward]));
    expect(pointsOf(cut)).toEqual([
      [
        [-180, -70],
        [-90, -75],
        [0, -70],
        [90, -75],
        [180, -70],
        [180, -90],
        [-180, -90],
      ],
    ]);
    expect(ringArea(cut, 0)).toBeLessThan(0);
  });

  it('closes a ring around the north pole along +90', () => {
    const arctic: Point[] = [
      [-170, 70],
      [-60, 75],
      [60, 72],
      [170, 70],
    ];
    const [piece] = pointsOf(cutRings(partsOf([arctic])));
    expect(piece).toContainEqual([180, 90]);
    expect(piece).toContainEqual([-180, 90]);
    expect(piece.every(([, y]) => y >= 70)).toBe(true);
  });

  it('keeps a ring already closed along the pole, as Natural Earth draws Antarctica', () => {
    const drawn: Point[] = [
      [180, -80],
      [90, -75],
      [0, -80],
      [-90, -75],
      [-180, -80],
      [-180, -90],
      [180, -90],
    ];
    const cut = cutRings(partsOf([drawn]));
    const [piece] = pointsOf(cut);
    expect(piece).toHaveLength(drawn.length);
    expect([...piece].sort()).toEqual([...drawn].sort());
    expect(ringArea(cut, 0)).toBeCloseTo(ringArea(partsOf([drawn]), 0));
  });
});

describe('simplificationAreas', () => {
  // Two squares sharing the edge x ≈ 1, with wobbly points along it; B runs the edge in reverse.
  const border: Point[] = [
    [1.02, 0.2],
    [0.97, 0.4],
    [1.05, 0.6],
    [0.99, 0.8],
  ];
  const squares = partsOf([
    [[0, 0], [1, 0], ...border, [1, 1], [0, 1], [-0.03, 0.5]],
    [[1, 0], [2, 0], [2.02, 0.3], [2, 1], [1, 1], ...[...border].reverse()],
  ]);

  it('simplifies a shared border the same way in both rings at every level', () => {
    const areas = simplificationAreas(squares, true),
      levels = [0, ...new Set(Array.from(areas).filter(Number.isFinite)), 1e9].sort(
        (a, b) => a - b,
      );
    for (const tolerance of levels) {
      const [a, b] = pointsOf(simplified(squares, areas, tolerance, true));
      expect(a.length).toBeGreaterThanOrEqual(3);
      expect(b.length).toBeGreaterThanOrEqual(3);
      const shared = (ring: Point[]) =>
        ring
          .filter(([x]) => x > 0.5 && x < 1.5)
          .map(String)
          .sort();
      expect(shared(a)).toEqual(shared(b));
    }
  });

  it('keeps junctions where the shared border ends', () => {
    const areas = simplificationAreas(squares, true),
      points = pointsOf(squares).flat();
    points.forEach(([x, y], i) => {
      if ((x === 1 && y === 0) || (x === 1 && y === 1)) expect(areas[i]).toBe(Infinity);
    });
  });

  it('ranks an arc and its reverse identically, ties included', () => {
    // Every interior triangle has the same area, so only coordinates break ties.
    const zigzag: Point[] = Array.from({ length: 9 }, (_, i) => [i, i % 2] as const);
    const forward = Array.from(simplificationAreas(partsOf([zigzag]), false)),
      backward = Array.from(simplificationAreas(partsOf([[...zigzag].reverse()]), false));
    expect(backward.reverse()).toEqual(forward);
    const both = simplificationAreas(partsOf([zigzag, [...zigzag].reverse()]), false);
    expect(Array.from(both.subarray(9)).reverse()).toEqual(Array.from(both.subarray(0, 9)));
  });

  it('ranks a ring the same whatever its start and direction', () => {
    const ring = wobblyRing(60, 0, 0, 10, 7),
      turned = [...ring.slice(17), ...ring.slice(0, 17)].reverse(),
      byPoint = (points: Point[]) => {
        const areas = simplificationAreas(partsOf([points]), true);
        return new Map(points.map((point, i) => [String(point), areas[i]]));
      };
    expect(byPoint(turned)).toEqual(byPoint(ring));
  });

  it('keeps the endpoints of lines and the points where lines meet', () => {
    const lines = partsOf([
      [
        [0, 0],
        [0.5, 0.6],
        [1, 1],
        [1.5, 1.4],
        [2, 2],
      ],
      [
        [0, 2],
        [0.5, 1.4],
        [1, 1],
        [1.5, 0.6],
        [2, 0],
      ],
    ]);
    const areas = Array.from(simplificationAreas(lines, false));
    expect(areas.map((area) => area === Infinity)).toEqual([
      true,
      false,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(pointsOf(simplified(lines, Float64Array.from(areas), 1e9, false))).toEqual([
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      [
        [0, 2],
        [1, 1],
        [2, 0],
      ],
    ]);
  });

  it('keeps at least three points of every ring', () => {
    const lone = simplificationAreas(partsOf([wobblyRing(40, 0, 0, 5, 3)]), true);
    expect(Array.from(lone).filter((area) => area === Infinity)).toHaveLength(3);
    // Squares sharing a plain edge: each ring is two junctions plus two points of its own.
    const plain = partsOf([
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      [
        [1, 0],
        [2, 0],
        [2, 1],
        [1, 1],
      ],
    ]);
    const areas = simplificationAreas(plain, true),
      coarse = simplified(plain, areas, 1e9, true);
    expect(Array.from(coarse.parts)).toEqual([0, 3, 6]);
  });

  it('matches plain Visvalingam–Whyatt, with areas that only grow as points go', () => {
    const next = random(11),
      line: Point[] = Array.from({ length: 300 }, (_, i) => [i, 10 * next()] as const),
      areas = Array.from(simplificationAreas(partsOf([line]), false)),
      { areas: expected, order } = visvalingam(line);
    expect(areas).toEqual(expected);
    for (let k = 1; k < order.length; k++)
      expect(areas[order[k]]).toBeGreaterThanOrEqual(areas[order[k - 1]]);
  });

  it('ranks a million points quickly', () => {
    const grid = gridOfCells(100, 25);
    expect(grid.coordinates.length / 2).toBe(1_000_000);
    let start = performance.now();
    const areas = simplificationAreas(grid, true);
    const gridTime = performance.now() - start;
    expect(areas).toHaveLength(1_000_000);
    const coarse = simplified(grid, areas, 0.01, true);
    expect(coarse.parts.length - 1).toBe(10_000);

    const ring = partsOf([wobblyRing(1_000_000, 0, 0, 10, 5)]);
    start = performance.now();
    simplificationAreas(ring, true);
    const ringTime = performance.now() - start;
    expect(gridTime).toBeLessThan(3000);
    expect(ringTime).toBeLessThan(3000);
  }, 30_000);
});

describe('simplified', () => {
  it('keeps points above the tolerance and says where each came from', () => {
    const line = partsOf([
      [
        [0, 0],
        [1, 1],
        [2, 0],
        [3, 0.01],
        [4, 0],
      ],
    ]);
    const areas = simplificationAreas(line, false);
    // The flat bump goes first; its neighbor then takes the area of the larger triangle it leaves.
    expect(Array.from(areas)).toEqual([Infinity, 1, 1, 0.01, Infinity]);
    const out = simplified(line, areas, 0.1, false);
    expect(pointsOf(out)).toEqual([
      [
        [0, 0],
        [1, 1],
        [2, 0],
        [4, 0],
      ],
    ]);
    expect(Array.from(out.source)).toEqual([0, 1, 2, 4]);
    expect(pointsOf(simplified(line, areas, 1, false))).toEqual([
      [
        [0, 0],
        [4, 0],
      ],
    ]);
  });

  it('rejects areas that do not match the points', () => {
    const line = partsOf([
      [
        [0, 0],
        [1, 1],
      ],
    ]);
    expect(codeOf(() => simplified(line, new Float64Array(3), 0, false))).toBe('invalid-input');
  });
});

describe('triangulate', () => {
  const outer: Point[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const hole: Point[] = [
    [3, 3],
    [3, 7],
    [7, 7],
    [7, 3],
  ];

  function triangleArea(polygon: Parts, first: number, triangles: Uint32Array): number {
    const xy = polygon.coordinates,
      base = polygon.parts[first];
    let sum = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]].map(
        (i) => 2 * (base + i),
      );
      sum += Math.abs(
        (xy[b] - xy[a]) * (xy[c + 1] - xy[a + 1]) - (xy[c] - xy[a]) * (xy[b + 1] - xy[a + 1]),
      );
    }
    return sum / 2;
  }

  it('covers a square with a hole exactly', () => {
    const polygon = partsOf([outer, hole]),
      triangles = triangulate(polygon, 0, 2);
    expect(triangles.length % 3).toBe(0);
    expect(Math.max(...triangles)).toBeLessThan(8);
    expect(triangleArea(polygon, 0, triangles)).toBeCloseTo(84);
  });

  it('indexes the points of the polygon itself, wherever it starts', () => {
    const polygon = partsOf([wobblyRing(5, 50, 50, 1, 1), outer, hole]),
      triangles = triangulate(polygon, 1, 2);
    expect(Math.max(...triangles)).toBeLessThan(8);
    expect(triangleArea(polygon, 1, triangles)).toBeCloseTo(84);
  });

  it('returns no triangles for degenerate input', () => {
    const line = partsOf([
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    ]);
    expect(triangulate(line, 0, 1)).toHaveLength(0);
    expect(triangulate(line, 0, 0)).toHaveLength(0);
    expect(
      triangulate(
        partsOf([
          [
            [0, 0],
            [1, 1],
          ],
        ]),
        0,
        1,
      ),
    ).toHaveLength(0);
  });

  it('rejects rings out of range', () => {
    expect(codeOf(() => triangulate(partsOf([outer]), 0, 2))).toBe('invalid-input');
    expect(codeOf(() => triangulate(partsOf([outer]), -1, 1))).toBe('invalid-input');
  });
});

describe('polygonsOf and ringArea', () => {
  it('signs ring areas by winding', () => {
    const rings = partsOf([
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ],
      [
        [0, 0],
        [0, 2],
        [2, 2],
        [2, 0],
      ],
    ]);
    expect(areasOf(rings)).toEqual([4, -4]);
  });

  it('groups holes under the counter-clockwise ring before them', () => {
    const square = (x: number, size: number): Point[] => [
        [x, 0],
        [x + size, 0],
        [x + size, size],
        [x, size],
      ],
      hole = (x: number): Point[] => [...square(x, 1)].reverse();
    const rings = partsOf([
      square(0, 10),
      hole(2),
      hole(5),
      square(20, 10),
      square(40, 10),
      hole(42),
    ]);
    expect(Array.from(polygonsOf(rings))).toEqual([0, 3, 4, 6]);
    expect(Array.from(polygonsOf(partsOf([])))).toEqual([0]);
  });
});

describe('labelPoint', () => {
  function inside(ring: readonly Point[], [x, y]: readonly [number, number]): boolean {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i],
        [bx, by] = ring[j];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) result = !result;
    }
    return result;
  }

  it('places the label inside a concave polygon, away from its notch', () => {
    // A U whose centroid falls in the notch.
    const u: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [7, 10],
      [7, 3],
      [3, 3],
      [3, 10],
      [0, 10],
    ];
    const label = labelPoint(partsOf([u]), 0, 1, 0.01);
    expect(inside(u, label)).toBe(true);
    // The widest spots are the U's bottom corners, about 1.76 from every side.
    const [x, y] = label;
    expect(Math.min(x, 10 - x, y)).toBeGreaterThan(1.7);
  });

  it('keeps the label out of a hole', () => {
    const outer: Point[] = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      hole: Point[] = [
        [2, 2],
        [2, 8],
        [8, 8],
        [8, 2],
      ];
    const [x, y] = labelPoint(partsOf([outer, hole]), 0, 2, 0.01);
    expect(inside(outer, [x, y])).toBe(true);
    expect(inside(hole, [x, y])).toBe(false);
  });

  it('rejects an empty polygon and a non-positive precision', () => {
    const square = partsOf([
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    ]);
    expect(codeOf(() => labelPoint(square, 0, 0, 1))).toBe('invalid-input');
    expect(codeOf(() => labelPoint(square, 0, 1, 0))).toBe('invalid-input');
  });
});

describe('malformed parts', () => {
  it('rejects parts that do not ascend, end short, or odd coordinates', () => {
    const coordinates = Float64Array.of(0, 0, 1, 1);
    expect(codeOf(() => cutLines({ coordinates, parts: Uint32Array.of(0, 2, 1, 2) }))).toBe(
      'invalid-input',
    );
    expect(codeOf(() => cutRings({ coordinates, parts: Uint32Array.of(0, 3) }))).toBe(
      'invalid-input',
    );
    expect(
      codeOf(() =>
        simplificationAreas(
          { coordinates: Float64Array.of(0, 0, 1), parts: Uint32Array.of(0, 1) },
          false,
        ),
      ),
    ).toBe('invalid-input');
    expect(codeOf(() => polygonsOf({ coordinates, parts: new Uint32Array(0) }))).toBe(
      'invalid-input',
    );
  });
});

/** Visvalingam–Whyatt by brute force over one open line: areas, and the order points go. */
function visvalingam(line: readonly Point[]): { areas: number[]; order: number[] } {
  const areas = line.map(() => Infinity),
    current = line.map(() => Infinity),
    alive = line.map((_, i) => i),
    order: number[] = [];
  const triangle = (a: number, b: number, c: number) => {
    const ax = line[a][0] - line[b][0],
      ay = line[a][1] - line[b][1],
      cx = line[c][0] - line[b][0],
      cy = line[c][1] - line[b][1];
    return Math.abs(ax * cy - ay * cx) / 2;
  };
  for (let k = 1; k + 1 < alive.length; k++) current[k] = triangle(k - 1, k, k + 1);
  while (alive.length > 2) {
    let least = 1;
    for (let k = 2; k + 1 < alive.length; k++) {
      const a = alive[k],
        b = alive[least];
      if (
        current[a] < current[b] ||
        (current[a] === current[b] &&
          (line[a][0] < line[b][0] || (line[a][0] === line[b][0] && line[a][1] < line[b][1])))
      )
        least = k;
    }
    const removed = alive[least],
      area = current[removed];
    areas[removed] = area;
    order.push(removed);
    alive.splice(least, 1);
    if (least - 1 > 0)
      current[alive[least - 1]] = Math.max(
        area,
        triangle(alive[least - 2], alive[least - 1], alive[least]),
      );
    if (least < alive.length - 1)
      current[alive[least]] = Math.max(
        area,
        triangle(alive[least - 1], alive[least], alive[least + 1]),
      );
  }
  return { areas, order };
}

/** A `cells` × `cells` grid of unit squares whose shared edges carry the same `segments − 1` wobbly points. */
function gridOfCells(cells: number, segments: number): Parts {
  const jitter = (i: number, j: number, k: number, vertical: number) => {
    let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791) ^ vertical;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return (((h ^ (h >>> 15)) >>> 0) / 2 ** 32 - 0.5) * 0.2;
  };
  const coordinates = new Float64Array(cells * cells * 4 * segments * 2),
    parts = new Uint32Array(cells * cells + 1);
  let n = 0;
  const push = (x: number, y: number) => {
    coordinates[2 * n] = x;
    coordinates[2 * n + 1] = y;
    n++;
  };
  // The edge from lattice point (i, j) along x (or y when vertical), from its start or its end, without its last point.
  const edge = (i: number, j: number, vertical: number, reverse: boolean) => {
    for (let s = 0; s < segments; s++) {
      const k = reverse ? segments - s : s,
        along = k / segments,
        across = k === 0 || k === segments ? 0 : jitter(i, j, k, vertical);
      if (vertical) push(i + across, j + along);
      else push(i + along, j + across);
    }
  };
  for (let j = 0; j < cells; j++)
    for (let i = 0; i < cells; i++) {
      parts[j * cells + i] = n;
      edge(i, j, 0, false);
      edge(i + 1, j, 1, false);
      edge(i, j + 1, 0, true);
      edge(i, j, 1, true);
    }
  parts[cells * cells] = n;
  return { coordinates, parts };
}
