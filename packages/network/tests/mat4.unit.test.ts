import { describe, it, expect } from 'vitest';
import { mat4Mul, mat4Perspective, mat4Invert } from '../src/camera/mat4.js';

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

describe('mat4Mul', () => {
  it('identity × identity = identity', () => {
    const out = new Float32Array(16);
    const id = identity();
    mat4Mul(out, id, id);
    for (let i = 0; i < 16; i++) {
      expect(out[i]).toBeCloseTo(id[i], 6);
    }
  });
});

describe('mat4Invert', () => {
  it('A x A^-1 = identity', () => {
    const a = new Float32Array(16);
    mat4Perspective(a, 0.6, 1.5, 0.01, 100);
    const inv = new Float32Array(16);
    mat4Invert(inv, a);
    const product = new Float32Array(16);
    mat4Mul(product, a, inv);
    const id = identity();
    for (let i = 0; i < 16; i++) {
      expect(product[i]).toBeCloseTo(id[i], 4);
    }
  });

  it('returns true for an invertible matrix', () => {
    const a = new Float32Array(16);
    mat4Perspective(a, 0.6, 1.5, 0.01, 100);
    const inv = new Float32Array(16);
    expect(mat4Invert(inv, a)).toBe(true);
  });

  it('returns false for a singular (zero) matrix', () => {
    const zero = new Float32Array(16);
    const out = new Float32Array(16);
    out.fill(999);
    expect(mat4Invert(out, zero)).toBe(false);
    for (let i = 0; i < 16; i++) {
      expect(out[i]).toBe(999);
    }
  });
});

describe('mat4Perspective', () => {
  it('maps near plane to depth 0 and far plane to depth 1', () => {
    const p = new Float32Array(16);
    mat4Perspective(p, Math.PI / 4, 1, 0.1, 100);
    // A point on the near plane (0,0,-near,1) in view space:
    // clip.z = p[10] * (-near) + p[14], clip.w = p[11] * (-near) = near
    // depth = clip.z / clip.w
    const nearZ = p[10] * -0.1 + p[14];
    const nearW = p[11] * -0.1;
    expect(nearZ / nearW).toBeCloseTo(0, 4);

    const farZ = p[10] * -100 + p[14];
    const farW = p[11] * -100;
    expect(farZ / farW).toBeCloseTo(1, 4);
  });
});
