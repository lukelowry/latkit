import { expect, it } from 'vitest';
import type { NumericColumn, RowsBlock } from '@latkit/model';
import { GraphSource } from './fixture.js';

it('publishes stable native recording axes with double-precision positions', async () => {
  const source = new GraphSource(25, 3);
  const read = async (at: number) => {
    const blocks: RowsBlock[] = [];
    for await (const block of source.query({
      kind: 'rows',
      from: 'node',
      select: ['baseX', 'baseY', 'x', 'y', 'z'],
      at,
      rows: { kind: 'range', index: source.index('node'), offset: 8, count: 5 },
    }))
      if (block.kind === 'rows') blocks.push(block);
    return blocks;
  };
  const a = await read(0),
    b = await read(5),
    repeated = await read(0);
  const values = (block: RowsBlock, field: string) =>
    (block.columns[field] as NumericColumn).values;
  expect(a.map((block) => block.rows)).toEqual([
    { kind: 'range', offset: 8, count: 3 },
    { kind: 'range', offset: 11, count: 2 },
  ]);
  expect(values(a[0], 'baseX')[0]).toBe(source.positions[16]);
  expect(values(a[0], 'baseY')[0]).toBe(source.positions[17]);
  for (const axis of ['x', 'y']) {
    expect(values(a[0], axis)).toBeInstanceOf(Float64Array);
    expect(values(a[0], axis).buffer).toBe(values(repeated[0], axis).buffer);
    expect(values(a[0], axis)[0]).not.toBe(values(b[0], axis)[0]);
    expect(Math.abs(Number(values(a[0], axis)[0]) - 1e9)).toBeLessThan(50);
  }
  expect(values(a[0], 'z')[0]).toBe(source.observations[0][8]);
  expect(values(b[0], 'z')[0]).toBe(source.observations[5][8]);
  expect(source.linksQueries).toBe(0);
});
