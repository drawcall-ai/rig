/** Opens the mouth: slits the skin along the lip line and sews a cavity into the slit. */

import * as THREE from 'three'
import type { Anatomy } from './anatomy.js'
import type { Surface } from './surface.js'

export interface Mouth {
  /** Slit vertices from corner to corner: upper and lower copies, sharing the two corner ends. */
  upper: number[]
  lower: number[]
  /** First cavity vertex; later vertices belong to the cavity. */
  cavityStart: number
}

/** Only triangles this close to the lip line are split. */
const BAND = 0.0073
/** Cavity depth into the head and half height. */
const DEPTH = 0.04
const HEIGHT = 0.0164
/** Only skin this far behind the lips is cut: the face, not the hair or the back of the head. */
const REACH = 0.0286

export function cutMouth(s: Surface, { mouth }: Anatomy, cavityMaterial: number): Mouth {
  const { center, left, right, line } = mouth
  const f = (v: number) => {
    const d = s.positions[v * 3 + 1] - line(s.positions[v * 3 + 2])
    return Math.abs(d) < 1e-9 ? 1e-9 : d
  }
  const inBand = (v: number) => {
    const x = s.positions[v * 3], z = s.positions[v * 3 + 2]
    return x > center.x - REACH && z > left - BAND && z < right + BAND && Math.abs(f(v)) < BAND
  }
  // crossing vertices keyed by unwelded edge + side, topological ids by welded edge + side
  const crossing = new Map<string, number>()
  const crossingTopo = new Map<string, number>()
  /** Per welded edge: the crossing's z and one upper and one lower vertex, for the slit chain. */
  const slit = new Map<string, { z: number; up?: number; down?: number; split: boolean }>()
  const cross = (a: number, b: number, side: 1 | -1): number => {
    const [i, j] = a < b ? [a, b] : [b, a]
    const t = f(i) / (f(i) - f(j))
    const z = s.positions[i * 3 + 2] + (s.positions[j * 3 + 2] - s.positions[i * 3 + 2]) * t
    // between the corners the slit opens (two copies); beyond them it stays one surface
    const split = z > left && z < right
    const key = `${i}_${j}_${split ? side : 0}`
    let v = crossing.get(key)
    if (v !== undefined) return v
    const [ti, tj] = s.topo[i] < s.topo[j] ? [s.topo[i], s.topo[j]] : [s.topo[j], s.topo[i]]
    const topoKey = `${ti}_${tj}_${split ? side : 0}`
    let id = crossingTopo.get(topoKey)
    if (id === undefined) crossingTopo.set(topoKey, (id = s.newTopo()))
    v = s.interpolate(i, j, t, id)
    crossing.set(key, v)
    const edge = `${ti}_${tj}`
    const entry = slit.get(edge) ?? { z, split }
    if (side > 0) entry.up ??= v
    else entry.down ??= v
    slit.set(edge, entry)
    return v
  }
  const triangles: number[] = [], materials: number[] = []
  for (let t = 0; t < s.triangles.length; t += 3) {
    const tri = [s.triangles[t], s.triangles[t + 1], s.triangles[t + 2]]
    const sign = tri.map((v) => Math.sign(f(v)))
    if (!tri.every(inBand) || (sign[0] === sign[1] && sign[1] === sign[2])) {
      triangles.push(...tri)
      materials.push(s.materials[t / 3])
      continue
    }
    // rotate so the lone vertex comes first, keeping winding
    const lone = sign[0] !== sign[1] && sign[0] !== sign[2] ? 0 : sign[1] !== sign[0] && sign[1] !== sign[2] ? 1 : 2
    const [l, a, b] = [tri[lone], tri[(lone + 1) % 3], tri[(lone + 2) % 3]]
    const own = sign[lone] > 0 ? 1 : -1
    const other = own > 0 ? -1 : 1
    const la = cross(l, a, own), bl = cross(b, l, own), oa = cross(l, a, other), ob = cross(b, l, other)
    triangles.push(l, la, bl, oa, a, b, oa, b, ob)
    materials.push(s.materials[t / 3], s.materials[t / 3], s.materials[t / 3])
  }
  s.triangles = triangles
  s.materials = materials
  // the slit chain by z: the split stretch plus one shared vertex at each end
  const chain = [...slit.values()].sort((a, b) => a.z - b.z)
  const first = chain.findIndex((c) => c.split), last = chain.findLastIndex((c) => c.split)
  const before = chain[first - 1], after = chain[last + 1]
  if (first < 0 || !before || !after) throw new Error('face: the lip line does not cross the skin between the mouth corners; check mouthCornerLeft/Right and mouthCenter lie where the lips meet')
  const split = chain.slice(first, last + 1)
  const open = split.filter((c) => c.up === undefined || c.down === undefined)
  if (open.length) throw new Error(`face: the lip line leaves the skin at ${open.length} points between the corners; place the mouth landmarks on the visible lip line`)
  const end0 = before.up ?? before.down, end1 = after.up ?? after.down
  if (end0 === undefined || end1 === undefined) throw new Error('face: the lip line has no corner vertex')
  const upper = [end0, ...split.map((c) => c.up ?? end0), end1]
  const lower = [end0, ...split.map((c) => c.down ?? end0), end1]
  return { upper, lower, cavityStart: sewCavity(s, upper, lower, center, cavityMaterial) }
}

/** Rings of the slit's rim pushed back into the head, opened vertically, closed at the back; returns the first cavity vertex. */
function sewCavity(s: Surface, upper: number[], lower: number[], center: THREE.Vector3, material: number): number {
  const cavityStart = s.count
  const n = upper.length
  const rim = [...upper, ...lower.slice(1, -1).reverse()]
  const rings: number[][] = [rim]
  const shape = (k: number) => Math.sqrt(Math.sin((Math.PI * k) / (n - 1)))
  for (const [depth, height] of [[0.15, 0.35], [0.35, 0.7], [0.6, 0.95], [0.85, 0.8], [1, 0.4]]) {
    rings.push(rim.map((v, r) => {
      const isUpper = r < n
      const k = isUpper ? r : n - 1 - (r - n + 1)
      const p = s.point(v)
      p.x -= DEPTH * depth
      p.y += (isUpper ? 1 : -1) * HEIGHT * height * shape(k)
      p.z = center.z + (p.z - center.z) * (1 - 0.25 * depth)
      return s.add(p, v)
    }))
  }
  const cavity: number[] = []
  for (let j = 0; j + 1 < rings.length; j++) {
    const a = rings[j], b = rings[j + 1]
    for (let r = 0; r < a.length; r++) {
      const r2 = (r + 1) % a.length
      cavity.push(a[r], b[r], b[r2], a[r], b[r2], a[r2])
    }
  }
  const back = rings[rings.length - 1]
  const c = new THREE.Vector3()
  for (const v of back) c.add(s.point(v))
  c.divideScalar(back.length)
  c.x -= DEPTH * 0.08
  const cap = s.add(c, back[0])
  for (let r = 0; r < back.length; r++) cavity.push(back[r], cap, back[(r + 1) % back.length])
  // faces point into the cavity: the back cap toward the opening in front of it
  const inward = s.facing(cavity, cavity.length - 3, c.clone().add(new THREE.Vector3(DEPTH, 0, 0)))
  s.triangles.push(...inward)
  for (let t = 0; t < inward.length; t += 3) s.materials.push(material)
  return cavityStart
}
