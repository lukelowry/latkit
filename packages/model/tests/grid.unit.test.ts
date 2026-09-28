import { describe, expect, it } from 'vitest';

import { formatNumber, type Model } from '../src/index.js';
import { createGrid } from '../src/grid.js';
import { byHand, sampleClass, sampleModel } from './fixture.js';

type Column = Model.Data['columns'][number];

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
    const asc = await grid.window('', { column: 0, dir: 'asc' }, 0, 10);
    expect(asc.rows.map((r) => r.index)).toEqual([2, 0, 1]);
    const desc = await grid.window('', { column: 0, dir: 'desc' }, 0, 10);
    expect(desc.rows.map((r) => r.index)).toEqual([0, 2, 1]);
    const text = await grid.window('', { column: 1, dir: 'desc' }, 0, 10);
    expect(text.rows.map((r) => r.index)).toEqual([2, 0, 1]);
    const flags = await grid.window('', { column: 2, dir: 'desc' }, 0, 10);
    expect(flags.rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('keeps a label sort and a column sort in separate caches', async () => {
    const grid = createGrid(['b', 'a'], [{ kind: 'text', id: '', label: 'x', values: ['a', 'b'] }]);
    const byLabel = await grid.window('', { column: null, dir: 'asc' }, 0, 10);
    const byColumn = await grid.window('', { column: 0, dir: 'asc' }, 0, 10);
    expect(byLabel.rows.map((r) => r.index)).toEqual([1, 0]);
    expect(byColumn.rows.map((r) => r.index)).toEqual([0, 1]);
  });

  it('sorts by label when the sort column is null and ignores a column it lacks', async () => {
    const grid = createGrid(bus.labels, bus.columns);
    const byLabel = await grid.window('', { column: null, dir: 'asc' }, 0, 10);
    expect(byLabel.rows.map((r) => r.label)).toEqual(['Middle', 'North', 'South']);
    const unknown = await grid.window('', { column: 9, dir: 'asc' }, 0, 10);
    expect(unknown.rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('windows and locates under a combined filter and sort', async () => {
    const grid = createGrid(bus.labels, bus.columns);
    const window = await grid.window('o', { column: 0, dir: 'asc' }, 1, 1);
    expect(window.total).toBe(2);
    expect(window.rows.map((r) => r.index)).toEqual([0]);
    expect(await grid.locate(0, 'o', { column: 0, dir: 'asc' })).toBe(1);
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
    const { rows, total } = await grid.window('', { column: 0, dir: 'asc' }, 0, 3);
    expect(total).toBe(count);
    expect(rows.map((r) => r.index)).toEqual([0, 7, 14]);
    expect(await grid.locate(7, '', { column: 0, dir: 'asc' })).toBe(1);
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
    expect(() => createGrid(['a'], [column, column])).toThrow("column 'x' repeats");
    const signal: Column = { kind: 'number', id: 'x', label: 'x', values: Float64Array.of(1) };
    expect(() => createGrid(['a'], [], [signal, signal])).toThrow("signal 'x' repeats");
    // A column and a signal may share an id: the grid tells them apart by kind.
    expect(createGrid(['a'], [column], [signal]).columns.map((c) => c.kind)).toEqual([
      'column',
      'signal',
    ]);
  });

  it('describes each column it shows, in cell order', () => {
    const grid = createGrid(bus.labels, bus.columns);
    expect(grid.columns).toEqual([
      { kind: 'column', id: 'Vm', label: 'Voltage', unit: 'pu' },
      { kind: 'column', id: 'zone', label: 'Zone' },
      { kind: 'column', id: 'slack', label: 'Slack' },
    ]);
    expect(Object.isFrozen(grid.columns)).toBe(true);
  });
});

describe('model.grid', () => {
  it('tables a class by its columns', async () => {
    const grid = await sampleModel().grid('bus');
    expect(grid.columns.map((column) => column.id)).toEqual(['Vm', 'zone', 'slack']);
    const { rows } = await grid.window('', null, 0, 10);
    expect(rows.map((row) => row.cells)).toEqual([
      ['1.02', 'A', 'true'],
      ['', '', 'false'],
      ['0.98', 'B', 'false'],
    ]);
  });

  it('adds every signal the recording holds, sampled at a time', async () => {
    const model = sampleModel();
    const { recording, recorder } = byHand(model);
    recorder.append(Float64Array.of(0, 1), { bus: Float32Array.of(1, 2, 3, 4, 5, 6) });
    const grid = await model.grid('bus', { recording, time: 0.5 });
    // The column and the signal share an id; the grid tells them apart by kind.
    expect(grid.columns.slice(3)).toEqual([
      { kind: 'signal', id: 'Vm', label: 'Voltage', unit: 'pu' },
    ]);
    const { rows } = await grid.window('', { column: 3, dir: 'desc' }, 0, 10);
    expect(rows.map((row) => row.cells[3])).toEqual(['3', '2', '1']);
    expect((await model.grid('gen', { recording, time: 1 })).columns).toEqual([
      { kind: 'signal', id: 'P', label: 'Power', unit: 'MW' },
    ]);
  });

  it('refuses a class it lacks and a time that is not finite', async () => {
    const model = sampleModel();
    await expect(model.grid('nope')).rejects.toThrow("unknown class 'nope'");
    const { recording } = byHand(model);
    await expect(model.grid('bus', { recording, time: Number.NaN })).rejects.toThrow(RangeError);
  });
});
