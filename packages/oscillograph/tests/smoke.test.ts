import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.js';

describe('package entrypoint', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@latkit/oscillograph');
  });
});
