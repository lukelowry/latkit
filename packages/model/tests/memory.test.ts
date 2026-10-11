import { expect, it } from 'vitest';
import { createMemory } from '../src/index.js';

it('never refuses what is held: room comes from what no one holds, and past that the pool runs over', () => {
  const memory = createMemory({ cpuBytes: 1024, gpuBytes: 1024, entries: 2 }),
    disposed: string[] = [];
  const a = memory.add([new ArrayBuffer(600)], 0, () => disposed.push('a')),
    b = memory.add([new ArrayBuffer(600)], 0, () => disposed.push('b'));
  // Both are held, past the budget.
  expect(memory.stats().cpuBytes).toBe(1200);
  a.unpin();
  // Room for the next comes from what no one holds, least recently used first.
  const c = memory.add([new ArrayBuffer(100)], 0, () => disposed.push('c'));
  expect(disposed).toEqual(['a']);
  expect(memory.stats().cpuBytes).toBe(700);
  // Past the entry budget too, while everything is held.
  memory.add([], 16, () => disposed.push('d'));
  expect(memory.stats().entries).toBe(3);
  // GPU resources run over in the same way, and their room comes back when they go.
  memory.reserveGpu(4096);
  expect(memory.stats().gpuBytes).toBe(4096);
  memory.releaseGpu(4096);
  expect(memory.stats().gpuBytes).toBe(0);
  // Transient copies are never refused either.
  expect(memory.stage(1 << 30, () => 'staged')).toBe('staged');
  b.unpin();
  c.unpin();
  memory.trim();
  expect(disposed.sort()).toEqual(['a', 'b', 'c']);
  memory.destroy();
});
