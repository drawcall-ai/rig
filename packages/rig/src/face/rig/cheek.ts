/**
 * The cheek as soft tissue. The cheek raiser (FACS AU6) bunches the malar fat into a round mass in front of the
 * cheekbone, stopped by the nasolabial line and the lower lid; it swells forward and spreads more than it rises.
 * Coarse meshes carry the broad shape; the wrinkle layer adds the same dome per pixel.
 */

import * as THREE from 'three'
import { CHEEK_MASS } from '../mass.js'
import type { Anatomy } from './anatomy.js'
import { smoothstep } from './math.js'
import type { Tissue } from './tissue.js'

/** Signed distance (template meters) lateral of the nasolabial line, at (y, |z|). */
function besideFold({ fold: [az, ay, bz, by] }: Anatomy['cheek'], y: number, z: number): number {
  return ((bz - az) * (y - ay) - (by - ay) * (z - az)) / Math.hypot(bz - az, by - ay)
}

/** The cheek mass at a rest point, 0..1: a flat-topped dome cut off along the nasolabial line. Side -1 is the left cheek (-z). */
export function cheekMass(cheek: Anatomy['cheek'], y: number, z: number, side: number): number {
  const az = z * side
  if (az < CHEEK_MASS.edge.midline) return 0
  const dz = (az - cheek.z) / CHEEK_MASS.size.wide, dy = (y - cheek.y) / (y > cheek.y ? CHEEK_MASS.size.up : CHEEK_MASS.size.down)
  const sd = besideFold(cheek, y, az)
  // a crisp boundary along the fold; above the nose wing a soft one
  const { crisp, soften } = CHEEK_MASS.edge
  const soft = smoothstep(cheek.fold[1] - CHEEK_MASS.edge.below, cheek.fold[1] + CHEEK_MASS.edge.above, y)
  return smoothstep(1, 0.3, Math.hypot(dz, dy)) * smoothstep(crisp[0] + soften[0] * soft, crisp[1] + soften[1] * soft, sd)
}

/** The cheek region, wider than the mass, lateral of the nasolabial line: the soft tissue that lags behind the lips. */
export function cheekZone(cheek: Anatomy['cheek'], y: number, z: number, side: number): number {
  const az = z * side
  if (az < CHEEK_MASS.edge.midline) return 0
  const dz = (az - cheek.z) / (CHEEK_MASS.size.wide * 1.5), dy = (y - cheek.y) / ((y > cheek.y ? CHEEK_MASS.size.up : CHEEK_MASS.size.down) * 1.5)
  return smoothstep(0, 0.5, 1 - Math.hypot(dz, dy)) * smoothstep(-0.00091, 0.00545, besideFold(cheek, y, az))
}

/**
 * The cheek mass swelling as a shape: skin slides along the surface toward the eye (wider than the mass, dragging its
 * surroundings), the mass thickens along the normal and its shoulders spread from the apex.
 */
export function cheekBulge(tissue: Tissue, normals: Float32Array, rimFade: Float32Array, side: number): Float32Array {
  const { rest, anatomy, mouth } = tissue
  const { cheek } = anatomy
  const { eyeY } = anatomy
  const lift = 0.00091, thickness = 0.00382, spread = 0.00164
  const out = new Float32Array(rest.length)
  const n = new THREE.Vector3(), d = new THREE.Vector3()
  for (let v = 0; v < mouth.cavityStart; v++) {
    const x = rest[v * 3], y = rest[v * 3 + 1], z = rest[v * 3 + 2]
    if (x < 0.0152) continue
    const m = cheekMass(cheek, y, z, side)
    const dz = (z * side - cheek.z) / (CHEEK_MASS.size.wide * 1.3), dy = (y - cheek.y) / (CHEEK_MASS.size.down * 1.2)
    const slide = z * side > 0.0109 ? Math.max(0, 1 - dz * dz - dy * dy) ** 2 : 0
    if (!m && !slide) continue
    const near = y > eyeY - 0.0109 ? rimFade[v] : 1
    const ry = y - cheek.y, rz = z - cheek.z * side, rl = Math.hypot(ry, rz) || 1
    const grow = spread * 4 * m * (1 - m) * rimFade[v]
    n.fromArray(normals, v * 3)
    d.set(0, lift * Math.max(slide, m) * (0.45 + 0.55 * near) + grow * ry / rl, grow * rz / rl)
    d.addScaledVector(n, -d.dot(n)).addScaledVector(n, thickness * m * rimFade[v]).toArray(out, v * 3)
  }
  return out
}
