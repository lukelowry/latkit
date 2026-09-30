/** Reusable read-contract checks. Supply another implementation/transport without changing tests. */
import { describe, expect, it } from 'vitest';
import type { Queryable, RowsQuery, QueryHeader } from '../src/index.js';
import { validateBlock, validateSchema } from '../src/index.js';

import { axisLength, axisValues } from './source.js';

export function queryConformance(
  name: string,
  open: () => Promise<{
    source: Queryable;
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
        for await (const block of source.query(query)) {
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
        for await (const block of source.query(query)) {
          expect(block.kind).toBe('schema');
          break;
        }
        let count = 0;
        for await (const block of source.query(query))
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
          source.query(query, { signal })[Symbol.asyncIterator]().next(),
        ).rejects.toMatchObject({ code: 'aborted' });
        expect(await source.describe()).toBeDefined();
      } finally {
        await close();
      }
    });
  });
}
