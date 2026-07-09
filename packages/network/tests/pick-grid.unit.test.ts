import { describe, expect, it } from 'vitest';

import { Grid } from '../src/pick/grid.js';
import type { Bounds } from '../src/topology/index.js';
import { mulberry32 } from './fixtures/random.js';

function collect(grid: Grid, cx: number, cy: number, r: number): number[] {
  const ids: number[] = [];
  grid.each(cx, cy, r, (id) => ids.push(id));
  return ids.sort((a, b) => a - b);
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / len2)) : 0;
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

describe('Grid points', () => {
  const bounds: Bounds = { xMin: 0, xMax: 10, yMin: 0, yMax: 10 };

  it('covers every point within the query radius and visits each id once', () => {
    const rand = mulberry32(7);
    const count = 500;
    const coords = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      coords[i * 2] = rand() * 10;
      coords[i * 2 + 1] = rand() * 10;
    }
    const grid = Grid.points(coords, count, bounds);

    for (let q = 0; q < 50; q++) {
      const cx = rand() * 12 - 1;
      const cy = rand() * 12 - 1;
      const r = rand() * 3;
      const visited = collect(grid, cx, cy, r);

      expect(new Set(visited).size).toBe(visited.length);
      for (let i = 0; i < count; i++) {
        if (Math.hypot(coords[i * 2]! - cx, coords[i * 2 + 1]! - cy) <= r) {
          expect(visited).toContain(i);
        }
      }
    }
  });

  it('handles degenerate bounds where every point coincides', () => {
    const coords = new Float32Array([5, 5, 5, 5, 5, 5]);
    const grid = Grid.points(coords, 3, { xMin: 5, xMax: 5, yMin: 5, yMax: 5 });
    expect(collect(grid, 5, 5, 0.1)).toEqual([0, 1, 2]);
    expect(collect(grid, 100, 100, 1)).toEqual([0, 1, 2]);
  });

  it('handles an empty item set', () => {
    const grid = Grid.points(new Float32Array(0), 0, { xMin: 0, xMax: 1, yMin: 0, yMax: 1 });
    expect(collect(grid, 0.5, 0.5, 10)).toEqual([]);
  });
});

describe('Grid segments', () => {
  function segmentGrid(
    segments: readonly (readonly [number, number, number, number])[],
    bounds: Bounds,
    wrapX = 0,
  ): Grid {
    // Pack endpoints in the encoded-record shape: 8-word stride, a at +4, b at +6.
    const f32 = new Float32Array(segments.length * 8);
    segments.forEach(([ax, ay, bx, by], i) => {
      f32[i * 8 + 4] = ax;
      f32[i * 8 + 5] = ay;
      f32[i * 8 + 6] = bx;
      f32[i * 8 + 7] = by;
    });
    return Grid.segments(f32, 0, 8, 4, 6, segments.length, bounds, wrapX);
  }

  it('covers randomized segments against a brute-force distance filter', () => {
    const rand = mulberry32(11);
    const bounds: Bounds = { xMin: -5, xMax: 5, yMin: -5, yMax: 5 };
    const segs: [number, number, number, number][] = [];
    for (let i = 0; i < 300; i++) {
      const ax = rand() * 10 - 5;
      const ay = rand() * 10 - 5;
      // Mix short local segments with occasional long diagonals.
      const reach = rand() < 0.1 ? 8 : 0.8;
      segs.push([ax, ay, ax + (rand() - 0.5) * reach, ay + (rand() - 0.5) * reach]);
    }
    const grid = segmentGrid(segs, bounds);

    for (let q = 0; q < 50; q++) {
      const cx = rand() * 12 - 6;
      const cy = rand() * 12 - 6;
      const r = rand() * 2;
      const visited = new Set(collect(grid, cx, cy, r));

      segs.forEach(([ax, ay, bx, by], i) => {
        if (pointSegmentDistance(cx, cy, ax, ay, bx, by) <= r) {
          expect(visited.has(i), `segment ${i} within ${r} of (${cx}, ${cy})`).toBe(true);
        }
      });
    }
  });

  it('does not flood cells far from a long diagonal', () => {
    const bounds: Bounds = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };
    // Enough filler segments that the grid has real resolution; the long
    // diagonal is id 0.
    const segs: [number, number, number, number][] = [[0, 0, 100, 100]];
    for (let i = 0; i < 99; i++) {
      const x = (i % 10) * 10 + 3;
      const y = Math.floor(i / 10) * 10 + 3;
      segs.push([x, y, x + 1, y + 1]);
    }
    const grid = segmentGrid(segs, bounds);
    // The row-slab clip keeps the diagonal out of the far corners.
    expect(collect(grid, 95, 5, 2)).not.toContain(0);
    expect(collect(grid, 5, 95, 2)).not.toContain(0);
    expect(collect(grid, 50, 50, 2)).toContain(0);
  });

  it('indexes a seam-crossing geo segment under both interpretations', () => {
    const bounds: Bounds = { xMin: -180, xMax: 180, yMin: -90, yMax: 90 };
    const grid = segmentGrid([[179, 0, -179, 0]], bounds, 360);

    // Wrapped arc (what the globe renders): present just inside both seams.
    expect(collect(grid, 179.5, 0, 1)).toEqual([0]);
    expect(collect(grid, -179.5, 0, 1)).toEqual([0]);
    // Direct chord (what flat/tilt render): crosses the middle of the map.
    expect(collect(grid, 0, 0, 1)).toEqual([0]);
  });
});
