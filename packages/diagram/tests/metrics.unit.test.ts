import { describe, expect, it } from 'vitest';

import { ADVANCE, columns, isWide, LINE } from '../src/text/metrics.js';
import { random } from './fixtures/netlists.js';

describe('text metrics', () => {
  it('fixes the monospace advance and line height', () => {
    expect(ADVANCE).toBe(0.6);
    expect(LINE).toBe(1.25);
  });

  it('counts one column per code point', () => {
    expect(columns('')).toBe(0);
    expect(columns('GENROU')).toBe(6);
    expect(columns('1_1_speed')).toBe(9);
    // A combining mark is its own code point.
    expect(columns('é')).toBe(2);
  });

  it('counts two columns for East Asian wide and fullwidth code points', () => {
    expect(columns('漢字')).toBe(4);
    expect(columns('한국')).toBe(4);
    expect(columns('カナ')).toBe(4);
    expect(columns('Ａ1')).toBe(3);
    expect(columns('a😀b')).toBe(4);
    // A supplementary ideograph is one code point in two UTF-16 units.
    expect(columns('\u{20000}')).toBe(2);
    expect(columns('\u{1D400}')).toBe(1);
  });

  it('counts as a search of every code point in the wide table would, fast path or not', () => {
    /** Columns by the table alone: every code point looked up. */
    const reference = (text: string): number => {
      let total = 0;
      for (const point of text) total += isWide(point.codePointAt(0)!) ? 2 : 1;
      return total;
    };
    // Every BMP code unit alone, lone surrogates included.
    for (let unit = 0; unit <= 0xffff; unit++) {
      const text = String.fromCharCode(unit);
      if (columns(text) !== reference(text)) expect(columns(text)).toBe(reference(text));
    }
    // Supplementary code points, a sample across every plane.
    for (let code = 0x10000; code <= 0x10ffff; code += 97) {
      const text = String.fromCodePoint(code);
      if (columns(text) !== reference(text)) expect(columns(text)).toBe(reference(text));
    }
    // Mixed strings: ASCII and Latin around the fast path's edge, wide ranges, emoji, astral
    // ideographs, and lone surrogates in any order.
    const pool = [0x41, 0x7a, 0xe9, 0x301, 0x10ff, 0x1100, 0x115f, 0x1160, 0x3000, 0x4e00];
    pool.push(0xac00, 0xd800, 0xdc00, 0xff01, 0xff61, 0x1f600, 0x20000, 0x1d400, 0x3fffd);
    const next = random(7);
    for (let i = 0; i < 2000; i++) {
      let text = '';
      const length = Math.floor(next() * 12);
      for (let k = 0; k < length; k++) {
        const base = pool[Math.floor(next() * pool.length)]!;
        const code = base + Math.floor(next() * 3) - 1;
        text +=
          code >= 0xd800 && code <= 0xdfff ? String.fromCharCode(code) : String.fromCodePoint(code);
      }
      expect(columns(text)).toBe(reference(text));
    }
  });

  it('finds wide ranges at their bounds', () => {
    expect(isWide(0x10ff)).toBe(false);
    expect(isWide(0x1100)).toBe(true);
    expect(isWide(0x115f)).toBe(true);
    expect(isWide(0x1160)).toBe(false);
    expect(isWide(0x3000)).toBe(true);
    expect(isWide(0x303f)).toBe(false);
    expect(isWide(0x4e00)).toBe(true);
    expect(isWide(0xff01)).toBe(true);
    expect(isWide(0xff61)).toBe(false);
    expect(isWide(0x3fffd)).toBe(true);
    expect(isWide(0x3fffe)).toBe(false);
    expect(isWide(0x41)).toBe(false);
  });
});
