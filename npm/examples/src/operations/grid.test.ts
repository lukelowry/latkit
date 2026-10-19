import { describe, expect, test } from 'vitest';
import { Grid } from './grid.js';
import texas from './texas.json';

/** MW each substation sends out along its branches in service, by the flows solved. */
function sent(grid: Grid): Float64Array {
  const out = new Float64Array(grid.n);
  texas.branches.forEach((branch, j) => {
    out[branch.from]! += grid.flow[j]!;
    out[branch.to]! -= grid.flow[j]!;
  });
  return out;
}

/** The largest gap between what each substation injects and what its branches carry away. */
function imbalance(grid: Grid): number {
  const out = sent(grid);
  return Math.max(...Array.from(out, (mw, i) => Math.abs(mw - grid.injection[i]!)));
}

describe('the DC power flow', () => {
  test('balances every island: plants make what loads are served, and each bus sends on its injection', () => {
    const grid = new Grid();
    const total = grid.injection.reduce((sum, mw) => sum + mw, 0);
    expect(Math.abs(total)).toBeLessThan(1e-6);
    expect(imbalance(grid)).toBeLessThan(1e-6);
    expect(grid.dark).toBe(0);
  });

  test('a tripped branch carries nothing, and the rest take its flow', () => {
    const grid = new Grid();
    const before = Float64Array.from(grid.flow);
    grid.tripWorst();
    const tripped = grid.out.findIndex((out) => out === 1);
    expect(tripped).toBeGreaterThanOrEqual(0);
    expect(grid.trips).toBe(1);
    expect(grid.flow[tripped]).toBe(0);
    expect(imbalance(grid)).toBeLessThan(1e-6);
    expect(grid.flow.some((mw, j) => j !== tripped && Math.abs(mw - before[j]!) > 1e-3)).toBe(true);
  });

  test('restoring recloses every branch and solves as before', () => {
    const grid = new Grid();
    const before = Float64Array.from(grid.flow);
    grid.tripWorst();
    grid.restore();
    expect(grid.out.every((out) => out === 0)).toBe(true);
    expect(grid.trips).toBe(0);
    grid.flow.forEach((mw, j) => expect(mw).toBeCloseTo(before[j]!, 6));
  });

  test('more demand loads branches more', () => {
    const grid = new Grid();
    const loaded = () => grid.loading.reduce((sum, l) => sum + l, 0);
    const light = loaded();
    grid.demand = 1.1;
    grid.step(0);
    expect(loaded()).toBeGreaterThan(light);
  });
});
