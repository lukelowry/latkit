import { expect, it } from 'vitest';
import { BoxIndex, Occupancy, type BoxRead } from '../src/spatial/boxes.js';

/** Drive a build to its index, counting its pauses. */
function build(count: number, extent: readonly [number, number, number, number], read: BoxRead) {
  const steps = BoxIndex.build(count, extent, read);
  let pauses = 0;
  for (let step = steps.next(); ; step = steps.next(), pauses++)
    if (step.done) return { index: step.value, pauses };
}
/** Every item a query visits, in visit order. */
function query(index: BoxIndex, bounds: readonly [number, number, number, number]): number[] {
  const out: number[] = [];
  index.some(bounds, (item) => void out.push(item));
  return out;
}
it.each([0, 1e9])('finds every box a query meets, never a non-finite one, about %d', (offset) => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const count = 5000,
    boxes = Array.from({ length: count }, (_, i) => {
      if (i % 97 === 0) return [NaN, 0, 1, 1];
      const x = offset + random() * 1000,
        y = offset + random() * 1000,
        size = i % 3 ? random() * 20 : 0;
      return [x, y, x + size, y + size * random()];
    });
  const { index, pauses } = build(count, [offset, offset, offset + 1020, offset + 1020], (i, box) =>
    box.set(boxes[i]),
  );
  expect(pauses).toBeGreaterThan(1);
  expect(index.bytes).toBe(BoxIndex.bytes(count));
  for (let q = 0; q < 200; q++) {
    const x = offset + random() * 1100 - 50,
      y = offset + random() * 1100 - 50,
      r = q % 4 ? random() * 5 : random() * 200;
    const bounds = [x - r, y - r, x + r, y + r] as const,
      found = query(index, bounds);
    const meets = (box: number[], slack: number) =>
      box.every(Number.isFinite) &&
      box[0] <= bounds[2] + slack &&
      box[1] <= bounds[3] + slack &&
      box[2] >= bounds[0] - slack &&
      box[3] >= bounds[1] - slack;
    expect(new Set(found).size).toBe(found.length);
    // Float32 boxes about the data's center round outward by at most a few ulps of the extent.
    for (const item of found) expect(meets(boxes[item], 1e-3)).toBe(true);
    const exact = boxes.flatMap((box, i) => (meets(box, 0) ? [i] : []));
    expect(found).toEqual(expect.arrayContaining(exact));
  }
});
it('keeps about 21 bytes per item and queries an empty index', () => {
  expect(BoxIndex.bytes(1_000_000) / 1_000_000).toBeCloseTo(21.07, 2);
  const { index } = build(0, [0, 0, 0, 0], () => {});
  expect(query(index, [-1, -1, 1, 1])).toEqual([]);
  const single = build(1, [2, 3, 2, 3], (_, box) => box.set([2, 3, 2, 3])).index;
  expect(query(single, [2, 3, 2, 3])).toEqual([0]);
  expect(single.some([2, 3, 2, 3], (item) => item === 0)).toBe(true);
  expect(query(single, [2.001, 3, 3, 4])).toEqual([]);
});
it('places boxes only where nothing placed overlaps them', () => {
  const occupied = new Occupancy(16);
  expect(occupied.place([0, 0, 10, 10])).toBe(true);
  expect(occupied.place([5, 5, 30, 30])).toBe(false);
  expect(occupied.place([10, 0, 40, 10])).toBe(true);
  expect(occupied.free([-50, -50, -1, -1])).toBe(true);
  occupied.add([-50, -50, -1, -1]);
  expect(occupied.free([-20, -20, -10, -10])).toBe(false);
  expect(BoxIndex.of(2, [0, 0, 4, 4], (i, box) => box.set([i * 4, 0, i * 4, 0])).bytes).toBe(
    BoxIndex.bytes(2),
  );
});
