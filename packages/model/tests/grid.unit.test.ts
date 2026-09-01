import { describe, expect, it } from 'vitest';

import { createGrid, formatNumber, type Column } from '../src/index.js';
import { sampleClass } from './fixture.js';

describe('formatNumber', () => {
  it('applies the shared number rule', () => {
    expect(formatNumber(NaN)).toBe('');
    expect(formatNumber(Infinity)).toBe('∞');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(Math.fround(1.02))).toBe('1.02');
    expect(formatNumber(123456)).toBe('1.235e+5');
    expect(formatNumber(0.0001234)).toBe('1.234e-4');
    expect(formatNumber(-2.5)).toBe('-2.5');
  });
});

describe('createGrid', () => {
  const bus = sampleClass('bus');

  it('formats windows in natural order', async () => {
    const grid = createGrid(bus.labels, bus.columns);
    const { rows, total } = await grid.window('', null, 0, 10);
    expect(total).toBe(3);
    expect(rows.map((row) => row.label)).toEqual(['North', 'Middle', 'South']);
    expect(rows[0]!.cells).toEqual(['1.02', 'A', 'true']);
    expect(rows[1]!.cells).toEqual(['', '', 'false']);
    expect(rows[2]!.cells).toEqual(['0.98', 'B', 'false']);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
  });

  it('searches labels and cells case-insensitively', async () => {
    const grid = createGrid(bus.labels, bus.columns);
    expect((await grid.window('SOUTH', null, 0, 10)).rows.map((r) => r.index)).toEqual([2]);
    expect((await grid.window('true', null, 0, 10)).rows.map((r) => r.index)).toEqual([0]);
    expect((await grid.window('zzz', null, 0, 10)).total).toBe(0);
  });

  it('sorts numerically with missing values last in both directions', async () => {
    const grid = createGrid(bus.labels, bus.columns);
    const asc = await grid.window('', { column: 'Vm', dir: 'asc' }, 0, 10);
    expect(asc.rows.map((r) => r.index)).toEqual([2, 0, 1]);
    const desc = await grid.window('', { column: 'Vm', dir: 'desc' }, 0, 10);
    expect(desc.rows.map((r) => r.index)).toEqual([0, 2, 1]);
    const text = await grid.window('', { column: 'zone', dir: 'desc' }, 0, 10);
    expect(text.rows.map((r) => r.index)).toEqual([2, 0, 1]);
    const flags = await grid.window('', { column: 'slack', dir: 'desc' }, 0, 10);
    expect(flags.rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('keeps a label sort and a column sort in separate caches', async () => {
    const grid = createGrid(['b', 'a'], [{ kind: 'text', id: '', label: 'x', values: ['a', 'b'] }]);
    const byLabel = await grid.window('', { column: null, dir: 'asc' }, 0, 10);
    const byColumn = await grid.window('', { column: '', dir: 'asc' }, 0, 10);
    expect(byLabel.rows.map((r) => r.index)).toEqual([1, 0]);
    expect(byColumn.rows.map((r) => r.index)).toEqual([0, 1]);
  });

  it('sorts by label when the sort column is null and ignores unknown columns', async () => {
    const grid = createGrid(bus.labels, bus.columns);
    const byLabel = await grid.window('', { column: null, dir: 'asc' }, 0, 10);
    expect(byLabel.rows.map((r) => r.label)).toEqual(['Middle', 'North', 'South']);
    const unknown = await grid.window('', { column: 'nope', dir: 'asc' }, 0, 10);
    expect(unknown.rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('windows and locates under a combined filter and sort', async () => {
    const grid = createGrid(bus.labels, bus.columns);
    const window = await grid.window('o', { column: 'Vm', dir: 'asc' }, 1, 1);
    expect(window.total).toBe(2);
    expect(window.rows.map((r) => r.index)).toEqual([0]);
    expect(await grid.locate(0, 'o', { column: 'Vm', dir: 'asc' })).toBe(1);
    expect(await grid.locate(1, 'o', null)).toBeNull();
    expect(await grid.locate(1, '', null)).toBe(1);
    expect(await grid.locate(9, '', null)).toBeNull();
  });

  it('sorts a class larger than one chunk stably', async () => {
    const count = 10_000;
    const labels = Array.from({ length: count }, (_, i) => `e${i}`);
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) values[i] = i % 7;
    const columns: Column[] = [{ kind: 'number', id: 'v', label: 'v', values }];
    const grid = createGrid(labels, columns);
    const { rows, total } = await grid.window('', { column: 'v', dir: 'asc' }, 0, 3);
    expect(total).toBe(count);
    expect(rows.map((r) => r.index)).toEqual([0, 7, 14]);
    expect(await grid.locate(7, '', { column: 'v', dir: 'asc' })).toBe(1);
  });

  it('rejects after dispose and on a caller abort', async () => {
    const grid = createGrid(bus.labels, bus.columns);
    const controller = new AbortController();
    controller.abort();
    await expect(grid.window('', null, 0, 1, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    grid.dispose();
    await expect(grid.window('', null, 0, 1)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses columns of the wrong length or with repeated ids', () => {
    expect(() =>
      createGrid(['a'], [{ kind: 'number', id: 'x', label: 'x', values: Float64Array.of(1, 2) }]),
    ).toThrow(/2 values for 1 rows/);
    const column: Column = { kind: 'flag', id: 'x', label: 'x', values: Uint8Array.of(1) };
    expect(() => createGrid(['a'], [column, column])).toThrow(/repeats/);
  });
});
