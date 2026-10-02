import assert from 'node:assert/strict';
import type {
  Data,
  RowsQuery,
  SamplesQuery,
  QueryOptions,
  NumericColumn,
} from '../../src/index.js';
import {
  read,
  blockByteLength,
  blockBuffers,
  validateBlock,
  validateSchema,
} from '../../src/index.js';
export const inputAt = (row: number): number => row - Math.floor(row / 1009) * 1009 - 504;
export interface ScanResult {
  cells: number;
  blocks: number;
  payloadBytes: number;
  maxBlockBytes: number;
  maxBackingBytes: number;
  checksum: number;
}
/** Independent oracle: each cell, row identity, block position and complete coverage is checked. */
export async function verifyRows(
  source: Data,
  count: number,
  options: QueryOptions = {},
  query: RowsQuery = { kind: 'rows', from: 'Node', select: ['value'] },
  rowAt: (position: number) => number = (position) => position,
  expected: (row: number) => number = inputAt,
): Promise<ScanResult> {
  assert.deepEqual(validateSchema(source.schema), []);
  let cells = 0,
    blocks = 0,
    payloadBytes = 0,
    checksum = 0,
    maxBlockBytes = 0,
    maxBackingBytes = 0;
  for await (const block of read(source, query, options)) {
    assert.equal(block.rowOffset, cells);
    assert.deepEqual(validateBlock(source.schema, query, block, options), []);
    const size = blockByteLength(block);
    payloadBytes += size;
    maxBlockBytes = Math.max(maxBlockBytes, size);
    maxBackingBytes = Math.max(
      maxBackingBytes,
      blockBuffers(block).reduce((n, b) => n + b.byteLength, 0),
    );
    blocks++;
    const column = block.columns[query.select[0]] as NumericColumn;
    const length = block.rows.kind === 'range' ? block.rows.count : block.rows.values.length;
    for (let i = 0; i < length; i++) {
      const row: number =
        block.rows.kind === 'range' ? block.rows.offset + i : block.rows.values[i];
      if (row !== rowAt(cells)) assert.fail('Row order/coverage mismatch at ' + cells);
      const value = column.values[column.offset + i];
      if (value !== expected(row)) assert.fail('Value mismatch at row ' + row + ': ' + value);
      if (block.ids) {
        const at: number = block.ids.offset + i;
        assert.equal(
          new TextDecoder().decode(
            block.ids.bytes.subarray(block.ids.offsets[at], block.ids.offsets[at + 1]),
          ),
          'n' + row,
        );
      }
      checksum += value;
      cells++;
    }
  }
  assert.equal(cells, count);
  return {
    cells,
    blocks,
    payloadBytes,
    maxBlockBytes,
    maxBackingBytes,
    checksum,
  };
}
export async function verifySamples(
  source: Data,
  rows: number,
  frames: number,
  first = 0,
  factor = 2,
  expected = inputAt,
): Promise<ScanResult> {
  const query: SamplesQuery = {
    kind: 'samples',
    from: 'Node',
    select: ['output'],
    window: { kind: 'frames', offset: first, count: frames },
  };
  const seen = new Uint32Array(frames);
  assert.deepEqual(validateSchema(source.schema), []);
  let blocks = 0,
    cells = 0,
    checksum = 0,
    payloadBytes = 0,
    maxBlockBytes = 0,
    maxBackingBytes = 0;
  for await (const block of read(source, query)) {
    assert.deepEqual(validateBlock(source.schema, query, block), []);
    blocks++;
    const size = blockByteLength(block);
    payloadBytes += size;
    maxBlockBytes = Math.max(maxBlockBytes, size);
    maxBackingBytes = Math.max(
      maxBackingBytes,
      blockBuffers(block).reduce((n, b) => n + b.byteLength, 0),
    );
    const column = block.columns.output,
      count = block.rows.kind === 'range' ? block.rows.count : block.rows.values.length;
    for (let f = 0; f < block.coordinates.length; f++) {
      const frame: number = block.firstFrame + f - first;
      assert.ok(frame >= 0 && frame < frames);
      assert.equal(block.rowOffset, seen[frame]);
      assert.equal(block.coordinates[f], first + frame);
      for (let i = 0; i < count; i++) {
        const row: number =
          block.rows.kind === 'range' ? block.rows.offset + i : block.rows.values[i];
        if (row !== seen[frame]++) assert.fail('Sample row coverage mismatch');
        const value = column.values[column.offset + f * column.frameStride + i * column.rowStride];
        if (value !== expected(row) * factor + block.coordinates[f])
          assert.fail('Sample mismatch at row ' + row);
        checksum += value;
        cells++;
      }
    }
  }
  for (const count of seen) assert.equal(count, rows);
  return {
    cells,
    blocks,
    payloadBytes,
    maxBlockBytes,
    maxBackingBytes,
    checksum,
  };
}
