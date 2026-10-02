/** Reusable read-contract checks. Supply another implementation/transport without changing tests. */
import { describe, expect, it } from 'vitest';
import type { Data, RowsQuery, QueryHeader } from '../src/index.js';
import {
  read,
  rowCount as axisLength,
  rowAt,
  validateBlock,
  validateSchema,
} from '../src/index.js';

const axisValues = (rows: import('../src/index.js').RowAxis) =>
  Array.from({ length: axisLength(rows) }, (_, i) => rowAt(rows, i));

export function queryConformance(
  name: string,
  open: () => Promise<{
    source: Data;
    query: RowsQuery;
    expectedRows: readonly number[];
    close: () => Promise<void>;
  }>,
): void {
  describe(name, () => {
    it('streams one coherent schema/data/index version and complete ordered rows', async () => {
      const { source, query, expectedRows, close } = await open();
      try {
        let header: QueryHeader | undefined;
        const actual: number[] = [];
        let version: string | undefined;
        let index: unknown;
        for await (const block of read(source, query)) {
          if (block.kind === 'schema') {
            expect(header).toBeUndefined();
            header = block;
            expect(validateSchema(header.schema)).toEqual([]);
            continue;
          }
          expect(header).toBeDefined();
          expect(block.version).toBe(header!.version);
          expect(validateBlock(header!.schema, query, block)).toEqual([]);
          version ??= block.version;
          index ??= block.index;
          expect(block.version).toBe(version);
          expect(block.index).toEqual(index);
          expect(block.position).toBe(actual.length);
          actual.push(...axisValues(block.rows));
        }
        expect(header).toBeDefined();
        expect(actual).toEqual(expectedRows);
      } finally {
        await close();
      }
    });
    it('supports early return and subsequent independent reads', async () => {
      const { source, query, expectedRows, close } = await open();
      try {
        for await (const block of read(source, query)) {
          expect(block.kind).toBe('schema');
          break;
        }
        let count = 0;
        for await (const block of read(source, query))
          if (block.kind !== 'schema') count += axisLength(block.rows);
        expect(count).toBe(expectedRows.length);
      } finally {
        await close();
      }
    });
    it('rejects an aborted request without closing the source', async () => {
      const { source, query, close } = await open();
      try {
        const signal = AbortSignal.abort();
        await expect(
          read(source, query, { signal })[Symbol.asyncIterator]().next(),
        ).rejects.toMatchObject({ code: 'aborted' });
        expect(source.schema).toBeDefined();
      } finally {
        await close();
      }
    });
  });
}
