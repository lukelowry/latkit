import { describe, expect, it } from 'vitest';

import {
  idOf,
  KINDS,
  PART_BLOCK,
  PART_GROUP,
  PART_NET,
  PART_PORT,
  partId,
  partIndex,
  partKind,
  partOf,
  samePart,
} from '../src/part.js';

describe('part ids', () => {
  it('orders kinds by their codes', () => {
    expect(KINDS[PART_BLOCK]).toBe('block');
    expect(KINDS[PART_PORT]).toBe('port');
    expect(KINDS[PART_NET]).toBe('net');
    expect(KINDS[PART_GROUP]).toBe('group');
    expect(Object.isFrozen(KINDS)).toBe(true);
  });

  it('round-trips every kind through an id, up to the last index', () => {
    const last = 2 ** 30 - 1;
    for (const kind of KINDS) {
      for (const index of [0, 1, 12345, last]) {
        const id = idOf({ kind, index });
        expect(partOf(id)).toEqual({ kind, index });
        expect(KINDS[partKind(id)]).toBe(kind);
        expect(partIndex(id)).toBe(index);
      }
    }
  });

  it('fits every id in a u32 and keeps kinds disjoint', () => {
    const top = partId(PART_GROUP, 2 ** 30 - 1);
    expect(top).toBe(0xffffffff);
    expect(Uint32Array.of(top)[0]).toBe(top);
    expect(partId(PART_PORT, 0)).toBeGreaterThan(partId(PART_BLOCK, 2 ** 30 - 1));
    expect(partId(PART_NET, 7)).toBe(2 * 2 ** 30 + 7);
  });

  it('gives -1 for a record that names no part', () => {
    expect(idOf({ kind: 'vertex' as never, index: 0 })).toBe(-1);
    expect(idOf({ kind: 'block', index: -1 })).toBe(-1);
    expect(idOf({ kind: 'block', index: 1.5 })).toBe(-1);
    expect(idOf({ kind: 'block', index: 2 ** 30 })).toBe(-1);
    expect(idOf({ kind: 'net', index: NaN })).toBe(-1);
  });

  it('compares records by kind and index', () => {
    expect(samePart({ kind: 'port', index: 3 }, { kind: 'port', index: 3 })).toBe(true);
    expect(samePart({ kind: 'port', index: 3 }, { kind: 'net', index: 3 })).toBe(false);
    expect(samePart({ kind: 'port', index: 3 }, { kind: 'port', index: 4 })).toBe(false);
  });
});
