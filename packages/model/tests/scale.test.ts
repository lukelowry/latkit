import { expect, it } from 'vitest';
import { staticData } from './fixture.js';
import { verifyRows, inputAt } from './scale/verify.js';
it.each(['borrowed', 'owned'] as const)(
  'checks every cell of a million-row %s read within its bound',
  async (buffers) => {
    const data = staticData(1000000, 4096),
      result = await verifyRows(data, 1000000, { buffers, maxBlockBytes: 65536 });
    expect(result.cells).toBe(1000000);
    expect(result.maxBlockBytes).toBeLessThanOrEqual(65536);
    if (buffers === 'owned') expect(result.maxBackingBytes).toBeLessThanOrEqual(65536);
  },
);
it('checks sparse ordering independently of the local reader', async () => {
  const data = staticData(10000),
    selected = [1, 100, 3000, 7000, 9999].sort((a, b) => inputAt(a) - inputAt(b) || a - b);
  const result = await verifyRows(
    data,
    selected.length,
    {},
    {
      kind: 'rows',
      from: 'Node',
      select: ['value'],
      rows: {
        kind: 'indices',
        index: data.tables.Node.index,
        values: Uint32Array.of(9999, 7000, 3000, 100, 1),
      },
      orderBy: [{ field: 'value', direction: 'ascending' }],
    },
    (i) => selected[i],
  );
  expect(result.cells).toBe(5);
});
