/** Column-major 4x4 matrix math on plain arrays, applied at an offset `mo` into packed per-vertex matrices. */

export type Mat4 = ArrayLike<number>

export function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Column-major a * b. */
export function multiply(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3]
    }
  }
  return out
}

export function transformPoint(out: Float32Array, o: number, m: Mat4, mo: number, p: ArrayLike<number>): void {
  const [x, y, z] = [p[0], p[1], p[2]]
  out[o] = m[mo] * x + m[mo + 4] * y + m[mo + 8] * z + m[mo + 12]
  out[o + 1] = m[mo + 1] * x + m[mo + 5] * y + m[mo + 9] * z + m[mo + 13]
  out[o + 2] = m[mo + 2] * x + m[mo + 6] * y + m[mo + 10] * z + m[mo + 14]
}

/** Linear part only (directions, tangents, morph position deltas). */
export function transformVector(out: Float32Array, o: number, m: Mat4, mo: number, v: ArrayLike<number>): void {
  const [x, y, z] = [v[0], v[1], v[2]]
  out[o] = m[mo] * x + m[mo + 4] * y + m[mo + 8] * z
  out[o + 1] = m[mo + 1] * x + m[mo + 5] * y + m[mo + 9] * z
  out[o + 2] = m[mo + 2] * x + m[mo + 6] * y + m[mo + 10] * z
}

/** Inverse-transpose of the linear part, for normals (not renormalized). */
export function transformNormal(out: Float32Array, o: number, m: Mat4, mo: number, n: ArrayLike<number>): void {
  const a = m[mo], b = m[mo + 1], c = m[mo + 2]
  const d = m[mo + 4], e = m[mo + 5], f = m[mo + 6]
  const g = m[mo + 8], h = m[mo + 9], i = m[mo + 10]
  // Cofactor matrix = det * inverse-transpose
  const c00 = e * i - f * h, c01 = f * g - d * i, c02 = d * h - e * g
  const c10 = c * h - b * i, c11 = a * i - c * g, c12 = b * g - a * h
  const c20 = b * f - c * e, c21 = c * d - a * f, c22 = a * e - b * d
  const det = a * c00 + d * c10 + g * c20
  const inv = det === 0 ? 0 : 1 / det
  const [x, y, z] = [n[0], n[1], n[2]]
  out[o] = inv * (c00 * x + c10 * y + c20 * z)
  out[o + 1] = inv * (c01 * x + c11 * y + c21 * z)
  out[o + 2] = inv * (c02 * x + c12 * y + c22 * z)
}

export function determinant3(m: Mat4, mo: number): number {
  const a = m[mo], b = m[mo + 1], c = m[mo + 2]
  const d = m[mo + 4], e = m[mo + 5], f = m[mo + 6]
  const g = m[mo + 8], h = m[mo + 9], i = m[mo + 10]
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e)
}
