import { expect, it } from 'vitest';

import { position } from '../src/position.js';

it('normalizes f64 differences and overflowing spans without losing their positions', () => {
  expect(position(1e12 + 0.25, [1e12, 1e12 + 1])).toBe(0.25);
  expect(position(0, [-1e308, 1e308])).toBe(0.5);
  expect(position(-1e308, [-1e308, 1e308])).toBe(0);
  expect(position(1e308, [-1e308, 1e308])).toBe(1);
  expect(position(NaN, [0, 1])).toBeNaN();
  expect(position(3, [2, 2])).toBe(0.5);
});
