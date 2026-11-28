/** A 3D thin-plate warp (kernel r, plus an affine part) taking template points onto the face's corresponding points. */

import * as THREE from 'three'

export class Warp {
  private readonly weights: number[][]
  private readonly affine: number[][]

  constructor(private readonly from: THREE.Vector3[], to: THREE.Vector3[]) {
    const n = from.length, size = n + 4
    const m = Array.from({ length: size }, () => new Array<number>(size).fill(0))
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) m[i][j] = from[i].distanceTo(from[j])
      const p = [1, from[i].x, from[i].y, from[i].z]
      for (let k = 0; k < 4; k++) { m[i][n + k] = p[k]; m[n + k][i] = p[k] }
    }
    const solution = [0, 1, 2].map((c) => solve(m.map((row) => row.slice()), [...to.map((p) => p.getComponent(c)), 0, 0, 0, 0]))
    this.weights = solution.map((s) => s.slice(0, n))
    this.affine = solution.map((s) => s.slice(n))
  }

  map(p: THREE.Vector3): THREE.Vector3 {
    const out = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      const a = this.affine[c]
      let s = a[0] + a[1] * p.x + a[2] * p.y + a[3] * p.z
      for (let i = 0; i < this.from.length; i++) s += this.weights[c][i] * p.distanceTo(this.from[i])
      out[c] = s
    }
    return new THREE.Vector3(out[0], out[1], out[2])
  }

  /** The local linear map at p (central differences over h), which carries template displacements across. */
  jacobian(p: THREE.Vector3, h = 0.004): THREE.Matrix3 {
    const columns = [0, 1, 2].map((k) => {
      const step = new THREE.Vector3().setComponent(k, h)
      return this.map(p.clone().add(step)).sub(this.map(p.clone().sub(step))).divideScalar(2 * h)
    })
    return new THREE.Matrix3().set(
      columns[0].x, columns[1].x, columns[2].x,
      columns[0].y, columns[1].y, columns[2].y,
      columns[0].z, columns[1].z, columns[2].z,
    )
  }
}

/** Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length
  for (let c = 0; c < n; c++) {
    let pivot = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r
    ;[a[c], a[pivot]] = [a[pivot], a[c]]
    ;[b[c], b[pivot]] = [b[pivot], b[c]]
    if (Math.abs(a[c][c]) < 1e-14) throw new Error('face: two landmarks coincide; each must be its own point')
    for (let r = c + 1; r < n; r++) {
      const k = a[r][c] / a[c][c]
      if (!k) continue
      for (let j = c; j < n; j++) a[r][j] -= k * a[c][j]
      b[r] -= k * b[c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let j = r + 1; j < n; j++) s -= a[r][j] * x[j]
    x[r] = s / a[r][r]
  }
  return x
}
