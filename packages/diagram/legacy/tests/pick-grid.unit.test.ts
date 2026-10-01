import { describe, expect, it } from 'vitest';

import { SpatialHash } from '../src/pick/grid.js';
import { random } from './fixtures/netlists.js';

/** The ids a query visits, in visit order. */
function ids(hash: SpatialHash, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  hash.query(x0, y0, x1, y1, (id) => out.push(id));
  return out;
}

/** The ids a query visits, ascending. */
function sorted(hash: SpatialHash, x0: number, y0: number, x1: number, y1: number): number[] {
  return ids(hash, x0, y0, x1, y1).sort((a, b) => a - b);
}

describe('SpatialHash', () => {
  it('visits the boxes a query intersects, each once', () => {
    const hash = new SpatialHash();
    hash.reset(10);
    hash.insert(0, 0, 0, 5, 5);
    hash.insert(1, 20, 20, 25, 25);
    // Spans many cells; visited once all the same.
    hash.insert(2, -100, -3, 100, 3);
    hash.insert(3, 50, 50, 50, 50);
    expect(hash.size).toBe(4);
    expect(sorted(hash, 1, 1, 2, 2)).toEqual([0, 2]);
    expect(sorted(hash, -1000, -1000, 1000, 1000)).toEqual([0, 1, 2, 3]);
    expect(ids(hash, 50, 50, 50, 50)).toEqual([3]);
    expect(ids(hash, 30, 30, 40, 40)).toEqual([]);
    // Touching edges count.
    expect(sorted(hash, 5, 5, 10, 10)).toEqual([0]);
    // Reversed corners are normalized.
    expect(sorted(hash, 2, 2, 1, 1)).toEqual([0, 2]);
  });

  it('tests the box, not just the cell', () => {
    const hash = new SpatialHash();
    hash.reset(100);
    hash.insert(7, 0, 0, 10, 10);
    expect(ids(hash, 50, 50, 60, 60)).toEqual([]);
  });

  it('replaces a box on insert and forgets it on remove', () => {
    const hash = new SpatialHash();
    hash.reset(16);
    hash.insert(4, 0, 0, 10, 10);
    hash.insert(4, 200, 200, 210, 210);
    expect(hash.size).toBe(1);
    expect(ids(hash, 0, 0, 10, 10)).toEqual([]);
    expect(ids(hash, 205, 205, 205, 205)).toEqual([4]);
    hash.remove(4);
    hash.remove(4);
    hash.remove(99);
    expect(hash.size).toBe(0);
    expect(ids(hash, -1e6, -1e6, 1e6, 1e6)).toEqual([]);
  });

  it('works at negative and far coordinates', () => {
    const hash = new SpatialHash();
    hash.reset(8);
    hash.insert(0, -1e5, -1e5, -1e5 + 4, -1e5 + 4);
    hash.insert(1, 1e7, -1e7, 1e7 + 1, -1e7 + 1);
    expect(ids(hash, -1e5 + 1, -1e5 + 1, -1e5 + 2, -1e5 + 2)).toEqual([0]);
    expect(ids(hash, 1e7, -1e7, 1e7, -1e7)).toEqual([1]);
  });

  it('keeps a non-finite box out of the index', () => {
    const hash = new SpatialHash();
    hash.reset(8);
    hash.insert(0, 0, 0, 4, 4);
    hash.insert(0, NaN, 0, 4, 4);
    hash.insert(1, 0, 0, Infinity, 4);
    expect(hash.size).toBe(0);
    expect(ids(hash, -10, -10, 10, 10)).toEqual([]);
  });

  it('lists an oversized box instead of stamping every cell', () => {
    const hash = new SpatialHash();
    hash.reset(1);
    hash.insert(0, 0, 0, 10_000, 10_000);
    hash.insert(1, 5, 5, 6, 6);
    hash.insert(2, 0, 0, 10_000, 10_000);
    expect(sorted(hash, 5000, 5000, 5000, 5000)).toEqual([0, 2]);
    expect(sorted(hash, 5, 5, 5, 5)).toEqual([0, 1, 2]);
    hash.remove(0);
    expect(sorted(hash, 5, 5, 5, 5)).toEqual([1, 2]);
    hash.insert(2, 1, 1, 2, 2);
    expect(sorted(hash, 5000, 5000, 5000, 5000)).toEqual([]);
    expect(hash.size).toBe(2);
  });

  it('clears every box and keeps the cell size; reset validates it', () => {
    const hash = new SpatialHash();
    hash.reset(32);
    for (let id = 0; id < 100; id++) hash.insert(id, id, id, id + 1, id + 1);
    hash.clear();
    expect(hash.size).toBe(0);
    expect(hash.cellSize).toBe(32);
    expect(ids(hash, -1e3, -1e3, 1e3, 1e3)).toEqual([]);
    hash.insert(3, 0, 0, 1, 1);
    expect(ids(hash, 0, 0, 0, 0)).toEqual([3]);
    expect(() => hash.reset(0)).toThrow(RangeError);
    expect(() => hash.reset(NaN)).toThrow(RangeError);
    expect(() => hash.reset(-4)).toThrow(RangeError);
    expect(hash.cellSize).toBe(32);
  });

  it('makes room up front for the ids a bulk build inserts, and works past it', () => {
    const hash = new SpatialHash();
    hash.insert(3, 0, 0, 1, 1);
    hash.reset(10, 5000);
    expect(hash.size).toBe(0);
    expect(hash.cellSize).toBe(10);
    // Boxes of about a cell, then more ids than were reserved.
    for (let id = 0; id < 8000; id++) hash.insert(id, id * 7, 3, id * 7 + 9, 12);
    expect(hash.size).toBe(8000);
    expect(sorted(hash, 70, 0, 80, 20)).toEqual([9, 10, 11]);
    expect(sorted(hash, 7 * 7999, 0, 7 * 7999, 20)).toEqual([7998, 7999]);
    // A smaller reserve later keeps what is there and starts empty.
    hash.reset(10, 10);
    expect(ids(hash, -1e6, -1e6, 1e6, 1e6)).toEqual([]);
    hash.insert(2, 0, 0, 1, 1);
    expect(ids(hash, 0, 0, 0, 0)).toEqual([2]);
  });

  it('dedupes a query nested inside another', () => {
    const hash = new SpatialHash();
    hash.reset(4);
    hash.insert(0, 0, 0, 20, 20);
    hash.insert(1, 10, 10, 30, 30);
    const outer: number[] = [];
    const inner: number[][] = [];
    hash.query(0, 0, 40, 40, (id) => {
      outer.push(id);
      inner.push(sorted(hash, 0, 0, 40, 40));
    });
    expect(outer.sort()).toEqual([0, 1]);
    expect(inner).toEqual([
      [0, 1],
      [0, 1],
    ]);
    // Stamps still work after the nesting.
    expect(sorted(hash, 0, 0, 40, 40)).toEqual([0, 1]);
  });

  it('agrees with a linear scan under random inserts, moves, and removes', () => {
    const next = random(7);
    const hash = new SpatialHash();
    hash.reset(25);
    const boxes = new Map<number, readonly [number, number, number, number]>();
    const box = (): readonly [number, number, number, number] => {
      const x = next() * 2000 - 1000;
      const y = next() * 2000 - 1000;
      // Mostly small boxes, some long thin ones like wire segments.
      const long = next() < 0.1;
      const w = long ? next() * 1500 : next() * 60;
      const h = long ? 2 : next() * 60;
      return [x, y, x + w, y + h];
    };
    for (let step = 0; step < 3000; step++) {
      const id = Math.floor(next() * 600);
      const roll = next();
      if (roll < 0.2) {
        hash.remove(id);
        boxes.delete(id);
      } else {
        const b = box();
        hash.insert(id, ...b);
        boxes.set(id, b);
      }
      if (step % 30 !== 0) continue;
      const [x0, y0, x1, y1] = next() < 0.1 ? [-5000, -5000, 5000, 5000] : box();
      const expected = [...boxes]
        .filter(([, b]) => b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0)
        .map(([id]) => id)
        .sort((a, b) => a - b);
      const got = ids(hash, x0, y0, x1, y1);
      expect(new Set(got).size).toBe(got.length);
      expect(got.sort((a, b) => a - b)).toEqual(expected);
      expect(hash.size).toBe(boxes.size);
    }
  });
});
