/**
 * Deformation transfer of the template's ARKit shapes: the template head is warped onto the face through the landmarks
 * and its dense lip line, each face vertex finds its closest compatible template point (upper lip to upper lip), and that
 * point's displacements are carried across by the warp's local linear map.
 */

import * as THREE from 'three'
import { rigid } from './fit.js'
import { harmonic } from './graph.js'
import { FITTED, templateLandmarks } from './landmarks.js'
import { LIP_SAMPLES, templateLipLine, type Template } from './template.js'
import type { Tissue } from './tissue.js'
import { Warp } from './warp.js'

/** Driven by the face's own lids and eyeball bones, not transferred. */
const OWN = /^eye(Blink|Wide|Look)/

/** Spatial hash cell for the closest-point search. */
const CELL = 0.00545
/** Template points farther than this are not matched; matches fade out from FADE to FADE + FADE_WIDTH. */
const REACH = 0.01453
const FADE = 0.00454, FADE_WIDTH = 0.00727

export function transfer(t: Template, tissue: Tissue): Record<string, Float32Array> {
  const { rest, graph, anatomy } = tissue
  const count = rest.length / 3
  const warp = warpOnto(t, tissue)
  const tp = t.positions
  const wp = new Float32Array(tp.length)
  const q = new THREE.Vector3()
  for (let i = 0; i < tp.length; i += 3) warp.map(q.fromArray(tp, i)).toArray(wp, i)
  const tIndex = t.faces
  const cells = new Map<string, number[]>()
  for (let f = 0; f < tIndex.length; f += 3) {
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(wp[tIndex[f] * 3 + k], wp[tIndex[f + 1] * 3 + k], wp[tIndex[f + 2] * 3 + k]) / CELL))
    const hi = [0, 1, 2].map((k) => Math.floor(Math.max(wp[tIndex[f] * 3 + k], wp[tIndex[f + 1] * 3 + k], wp[tIndex[f + 2] * 3 + k]) / CELL))
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const key = `${x},${y},${z}`
      const list = cells.get(key)
      if (list) list.push(f)
      else cells.set(key, [f])
    }
  }
  const side = lipSide(tissue)
  const names = Object.keys(t.targets).filter((n) => !OWN.test(n))
  const shapes: Record<string, Float32Array> = Object.fromEntries(names.map((n) => [n, new Float32Array(count * 3)]))
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), closest = new THREE.Vector3(), d = new THREE.Vector3()
  const neck = anatomy.mouth.center.y - 0.0977
  for (let v = 0; v < tissue.mouth.cavityStart; v++) {
    q.fromArray(rest, v * 3)
    const mobility = tissue.mobility(q)
    if (!mobility || q.y < neck) continue
    // near the lips, an upper-lip vertex only matches the template's upper lip, and lower the lower
    const sv = side[graph.node[v]] - 0.5
    const strict = Math.abs(sv) > 0.2
    let bestDistance = REACH, bestFace = -1
    let bestBary: [number, number, number] = [0, 0, 0]
    const cx = Math.floor(q.x / CELL), cy = Math.floor(q.y / CELL), cz = Math.floor(q.z / CELL)
    const seen = new Set<number>()
    for (let x = cx - 3; x <= cx + 3; x++) for (let y = cy - 3; y <= cy + 3; y++) for (let z = cz - 3; z <= cz + 3; z++) for (const f of cells.get(`${x},${y},${z}`) ?? []) {
      if (seen.has(f)) continue
      seen.add(f)
      const [ia, ib, ic] = [tIndex[f], tIndex[f + 1], tIndex[f + 2]]
      if (strict && ((t.lipSide[ia] + t.lipSide[ib] + t.lipSide[ic]) / 3 - 0.5) * sv < -0.01) continue
      const bary = closestOnTriangle(q, a.fromArray(wp, ia * 3), b.fromArray(wp, ib * 3), c.fromArray(wp, ic * 3), closest)
      const distance = closest.distanceTo(q)
      if (distance < bestDistance) { bestDistance = distance; bestFace = f; bestBary = bary }
    }
    if (bestFace < 0) continue
    const corners = [tIndex[bestFace], tIndex[bestFace + 1], tIndex[bestFace + 2]]
    const source = new THREE.Vector3()
    corners.forEach((corner, k) => source.addScaledVector(a.fromArray(tp, corner * 3), bestBary[k]))
    const jacobian = warp.jacobian(source)
    const fade = mobility * (1 - Math.min(1, Math.max(0, (bestDistance - FADE) / FADE_WIDTH)))
    for (const name of names) {
      const delta = t.targets[name]
      d.set(0, 0, 0)
      corners.forEach((corner, k) => d.addScaledVector(a.fromArray(delta, corner * 3), bestBary[k]))
      d.applyMatrix3(jacobian).multiplyScalar(fade).toArray(shapes[name], v * 3)
    }
  }
  for (const delta of Object.values(shapes)) fillCavity(delta, tissue)
  return shapes
}

/** The warp from template onto face: fitted landmarks plus both lip lines sampled corner to corner. */
function warpOnto(t: Template, tissue: Tissue): Warp {
  const fitted = FITTED.filter((name) => !name.startsWith('mouth'))
  const template = templateLandmarks(t).filter((_, i) => !FITTED[i].startsWith('mouth'))
  return new Warp([...template, ...templateLipLine(t)], [...fitted.map(tissue.anatomy.point), ...lipLine(tissue)])
}

/** The face's lip line from the slit's upper copies, at the LIP_SAMPLES positions between its corners. */
function lipLine({ rest, mouth, anatomy }: Tissue): THREE.Vector3[] {
  const upper = mouth.upper.map((v) => new THREE.Vector3().fromArray(rest, v * 3)).sort((a, b) => a.z - b.z)
  const { center, left, right } = anatomy.mouth
  return LIP_SAMPLES.map((u) => {
    const z = center.z + u * (u < 0 ? center.z - left : right - center.z)
    const i = Math.max(1, upper.findIndex((p) => p.z >= z))
    const a = upper[i - 1], b = upper[Math.min(i, upper.length - 1)]
    return a.clone().lerp(b, b.z === a.z ? 0 : (z - a.z) / (b.z - a.z))
  })
}

/** Upper (1) vs lower (0) lip side around the mouth: harmonic from the slit's two copies. */
function lipSide({ rest, graph, mouth, anatomy }: Tissue): Float32Array {
  const center = anatomy.mouth.center.clone().add(new THREE.Vector3(-0.0105, -0.0014, 0))
  const active = new Uint8Array(graph.adj.length)
  for (let v = 0; v < mouth.cavityStart; v++) if (new THREE.Vector3().fromArray(rest, v * 3).distanceTo(center) < 0.0727) active[graph.node[v]] = 1
  const fixed = new Map<number, number>()
  for (const v of mouth.upper) fixed.set(graph.node[v], 1)
  for (const v of mouth.lower) fixed.set(graph.node[v], 0)
  const side = harmonic(graph.adj, fixed, active, 3000, 0.5)
  // outside the mouth region no side applies
  for (let n = 0; n < side.length; n++) if (!active[n] && !fixed.has(n)) side[n] = 0.5
  return side
}

/** The mouth cavity: harmonic from the slit (transferred) to the jaw's rigid motion deep inside (still skull above). */
function fillCavity(delta: Float32Array, tissue: Tissue): void {
  const { rest, graph, mouth, anatomy } = tissue
  const count = rest.length / 3
  const active = new Uint8Array(graph.adj.length)
  for (let v = mouth.cavityStart; v < count; v++) active[graph.node[v]] = 1
  for (const v of [...mouth.upper, ...mouth.lower]) active[graph.node[v]] = 1
  const jaw = jawMotion(delta, tissue)
  const fixed = [0, 1, 2].map(() => new Map<number, number>())
  for (const v of [...mouth.upper, ...mouth.lower]) for (let k = 0; k < 3; k++) fixed[k].set(graph.node[v], delta[v * 3 + k])
  const q = new THREE.Vector3()
  const deep = anatomy.mouth.center.x - 0.0286
  for (let v = mouth.cavityStart; v < count; v++) {
    q.fromArray(rest, v * 3)
    if (q.x > deep) continue
    const moved = q.clone().applyMatrix4(jaw).sub(q).multiplyScalar(tissue.jaw[v])
    for (let k = 0; k < 3; k++) fixed[k].set(graph.node[v], moved.getComponent(k))
  }
  const solved = fixed.map((f) => harmonic(graph.adj, f, active, 1500))
  for (let v = mouth.cavityStart; v < count; v++) for (let k = 0; k < 3; k++) delta[v * 3 + k] = solved[k][graph.node[v]]
}

/** The rigid motion of the jaw under a displacement field: the best fit of the jaw core well below the lips. */
export function jawMotion(delta: Float32Array, { rest, jaw, mouth, anatomy }: Tissue): THREE.Matrix4 {
  const from: THREE.Vector3[] = [], to: THREE.Vector3[] = []
  for (let v = 0; v < mouth.cavityStart; v++) {
    const p = new THREE.Vector3().fromArray(rest, v * 3)
    if (jaw[v] < 1 || p.y > anatomy.mouth.line(p.z) - 0.0109) continue
    from.push(p)
    to.push(p.clone().add(new THREE.Vector3().fromArray(delta, v * 3)))
  }
  if (from.length < 10) throw new Error(`face: only ${from.length} tissue vertices on the jaw below the mouth; check the chin and mouth landmarks`)
  return rigid(from, to)
}

/** Closest point on a triangle (Ericson), written to `out`; returns its barycentric coordinates. */
function closestOnTriangle(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out: THREE.Vector3): [number, number, number] {
  const ab = b.clone().sub(a), ac = c.clone().sub(a), ap = p.clone().sub(a)
  const d1 = ab.dot(ap), d2 = ac.dot(ap)
  if (d1 <= 0 && d2 <= 0) { out.copy(a); return [1, 0, 0] }
  const bp = p.clone().sub(b), d3 = ab.dot(bp), d4 = ac.dot(bp)
  if (d3 >= 0 && d4 <= d3) { out.copy(b); return [0, 1, 0] }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out.copy(a).addScaledVector(ab, v); return [1 - v, v, 0] }
  const cp = p.clone().sub(c), d5 = ab.dot(cp), d6 = ac.dot(cp)
  if (d6 >= 0 && d5 <= d6) { out.copy(c); return [0, 0, 1] }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out.copy(a).addScaledVector(ac, w); return [1 - w, 0, w] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); out.copy(b).addScaledVector(c.clone().sub(b), w); return [0, 1 - w, w] }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  out.copy(a).addScaledVector(ab, v).addScaledVector(ac, w)
  return [1 - v - w, v, w]
}

