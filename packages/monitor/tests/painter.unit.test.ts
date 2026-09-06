import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNIFORM_LAYOUT } from '../src/painter.js';

describe('monitor uniform layout table', () => {
  it('matches the hand-written WGSL struct member for member', () => {
    const src = readFileSync(new URL('../src/gpu/segment.wgsl', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('struct Uniforms {'), src.indexOf('\n};'));
    const fields = [...body.matchAll(/^ {2}(\w+)\s*:\s*(\w+),/gm)].map((m) => ({
      name: m[1],
      type: m[2],
    }));
    expect(fields).toEqual(UNIFORM_LAYOUT.map(({ name, type }) => ({ name, type })));
  });
});
