/** Multiply two column-major 4x4 matrices: out = a * b. */
export function mat4Mul(out: Float32Array, a: Float32Array, b: Float32Array): void {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
}

/** Write a column-major perspective projection with WebGPU [0, 1] depth. */
export function mat4Perspective(
  out: Float32Array,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): void {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far); // WebGPU [0,1] depth
  out[11] = -1;
  out[14] = (far * near) / (near - far);
}

/**
 * Unproject an NDC point through an inverse view-projection matrix.
 *
 * Writes xyz world coordinates into `out`.
 */
export function mat4Unproject(
  out: Float64Array,
  nx: number,
  ny: number,
  nz: number,
  inv: Float32Array,
): void {
  const x = inv[0] * nx + inv[4] * ny + inv[8] * nz + inv[12];
  const y = inv[1] * nx + inv[5] * ny + inv[9] * nz + inv[13];
  const z = inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14];
  const w = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15];
  out[0] = x / w;
  out[1] = y / w;
  out[2] = z / w;
}

/** Invert a column-major 4x4 matrix via cofactors. Returns false if singular. */
export function mat4Invert(out: Float32Array, m: Float32Array): boolean {
  const [m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23, m30, m31, m32, m33] = m;
  const b00 = m00 * m11 - m01 * m10,
    b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10,
    b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11,
    b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30,
    b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30,
    b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31,
    b11 = m22 * m33 - m23 * m32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return false;
  det = 1 / det;
  out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * det;
  out[1] = (m02 * b10 - m01 * b11 - m03 * b09) * det;
  out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * det;
  out[3] = (m22 * b04 - m21 * b05 - m23 * b03) * det;
  out[4] = (m12 * b08 - m10 * b11 - m13 * b07) * det;
  out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * det;
  out[6] = (m32 * b02 - m30 * b05 - m33 * b01) * det;
  out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * det;
  out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * det;
  out[9] = (m01 * b08 - m00 * b10 - m03 * b06) * det;
  out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * det;
  out[11] = (m21 * b02 - m20 * b04 - m23 * b00) * det;
  out[12] = (m11 * b07 - m10 * b09 - m12 * b06) * det;
  out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * det;
  out[14] = (m31 * b01 - m30 * b03 - m32 * b00) * det;
  out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * det;
  return true;
}
