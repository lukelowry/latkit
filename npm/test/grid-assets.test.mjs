import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { inflate, parseCase } from '../examples/src/pages/grids/format.ts';

for (const id of ['wecc240', 'activsg2000', 'activsg10k', 'activsg25k', 'activsg70k']) {
  test(`grid asset: ${id}`, async () => {
    const bytes = await readFile(new URL(`../examples/public/grids/${id}.bin`, import.meta.url));
    const grid = parseCase(id, await inflate(new Uint8Array(bytes)));

    assert.ok(grid.header.buses > 0);
    assert.equal(grid.positions.length, grid.header.buses * 2);
    for (const refs of [grid.from, grid.to, grid.machineBus])
      assert.ok(refs.every((row) => row < grid.header.buses));
    for (let i = 0; i < grid.positions.length; i += 2) {
      assert.ok(Math.abs(grid.positions[i]) <= 180);
      assert.ok(Math.abs(grid.positions[i + 1]) <= 90);
    }
  });
}

test('invalid grid assets are rejected', () => {
  assert.throws(() => parseCase('invalid', new ArrayBuffer(16)), /not a grid case/);
});
