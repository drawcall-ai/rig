/** Best-fitting similarity and rigid transforms between corresponding point sets. */

import * as THREE from 'three'

/** Least-squares similarity (scale, rotation, offset) taking `from` onto `to` (Umeyama). Throws when the best fit mirrors: sides are swapped. */
export function similarity(from: THREE.Vector3[], to: THREE.Vector3[]): THREE.Matrix4 {
  const a = centroid(from), b = centroid(to)
  const rotation = polar(covariance(from, a, to, b))
  if (rotation.determinant() < 0) throw new Error('face: the landmarks mirror the template; Left and Right are swapped (left = up × forward, the character\'s own left)')
  let num = 0, den = 0
  for (let i = 0; i < from.length; i++) {
    const p = from[i].clone().sub(a)
    num += p.clone().applyMatrix3(rotation).dot(to[i].clone().sub(b))
    den += p.lengthSq()
  }
  const scale = num / den
  const linear = rotation.clone().multiplyScalar(scale)
  return new THREE.Matrix4().setFromMatrix3(linear).setPosition(b.clone().sub(a.clone().applyMatrix3(linear)))
}

/** Least-squares rigid motion taking `from` onto `to` (Kabsch). */
export function rigid(from: THREE.Vector3[], to: THREE.Vector3[]): THREE.Matrix4 {
  const a = centroid(from), b = centroid(to)
  const m = new THREE.Matrix4().setFromMatrix3(polar(covariance(from, a, to, b)))
  return m.setPosition(b.clone().sub(a.clone().applyMatrix4(m)))
}

function centroid(points: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3()
  for (const p of points) c.add(p)
  return c.divideScalar(points.length)
}

/** Σ (to - b)(from - a)ᵀ. */
function covariance(from: THREE.Vector3[], a: THREE.Vector3, to: THREE.Vector3[], b: THREE.Vector3): THREE.Matrix3 {
  const h = new Array<number>(9).fill(0)
  for (let k = 0; k < from.length; k++) {
    const p = from[k].clone().sub(a).toArray(), q = to[k].clone().sub(b).toArray()
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) h[i * 3 + j] += q[i] * p[j]
  }
  return new THREE.Matrix3().set(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8])
}

/** The orthogonal factor of a polar decomposition, by Newton iteration (avoids an SVD). */
function polar(m: THREE.Matrix3): THREE.Matrix3 {
  let r = m.clone()
  for (let it = 0; it < 40; it++) {
    const inverse = r.clone().invert().transpose().elements
    r = new THREE.Matrix3().fromArray(r.elements.map((x, i) => (x + inverse[i]) / 2))
  }
  return r
}
