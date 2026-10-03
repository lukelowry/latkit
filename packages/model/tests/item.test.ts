import { expect, it } from 'vitest';
import {
  createData,
  failure,
  isFailure,
  itemId,
  sameItem,
  textAt,
  textColumn,
  type Schema,
} from '../src/index.js';
import { position } from '../src/columns.js';

const schema: Schema = { types: { Node: { fields: {} } } };
const index = { source: 'items', type: 'Node', version: '1' };
const data = createData(schema, [
  {
    kind: 'rows',
    index,
    rows: { kind: 'indices', values: Uint32Array.of(2, 5, 9) },
    ids: textColumn(['a', 'b', 'c']),
    columns: {},
  },
]);

it('names a row by its row space and number, and reads its id back', () => {
  const item = { source: data, index, row: 5 };
  expect(itemId(item)).toBe('b');
  // The row space names the row, so a later Data value names the same item.
  expect(sameItem(item, { source: createData(schema, []), index: { ...index }, row: 5 })).toBe(
    true,
  );
  expect(sameItem(item, { ...item, row: 9 })).toBe(false);
  expect(() => itemId({ ...item, row: 3 })).toThrow('has no id');
  expect(() => itemId({ ...item, index: { ...index, version: '2' } })).toThrow(
    'identities do not match',
  );
});

it('finds rows on ascending and unordered sparse axes', () => {
  const ascending = { kind: 'indices', values: Uint32Array.of(1, 4, 9) } as const,
    unordered = { kind: 'indices', values: Uint32Array.of(9, 1, 4) } as const;
  expect([1, 4, 9, 5, 0, 10].map((row) => position(ascending, row))).toEqual([0, 1, 2, -1, -1, -1]);
  expect([9, 1, 4, 5].map((row) => position(unordered, row))).toEqual([0, 1, 2, -1]);
});

it('encodes null text as absent', () => {
  const column = textColumn(['x', null, 'zz']);
  expect([0, 1, 2].map((i) => textAt(column, i))).toEqual(['x', null, 'zz']);
  expect(textColumn(['x']).validity).toBeUndefined();
});

it('recognizes failures by code, from any package or peer', () => {
  expect(isFailure(failure('busy'), 'busy')).toBe(true);
  expect(isFailure(failure('busy'), 'closed')).toBe(false);
  expect(isFailure(Object.assign(new Error('peer'), { code: 'timeout' }))).toBe(true);
  expect(isFailure(new Error('plain'))).toBe(false);
  expect(failure('io', 'read', { cause: 'disk' }).cause).toBe('disk');
});
