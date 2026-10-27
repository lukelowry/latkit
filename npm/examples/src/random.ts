/** Returns a seeded random generator of numbers in [0, 1). The synthetic examples use it so their
 * sample data is the same on every load. */
export function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns a seeded linear congruential generator of numbers in [0, 1): a simpler sequence than
 * `random`'s, which the soft body's burst and the benchmark's data are drawn from. */
export function congruential(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
