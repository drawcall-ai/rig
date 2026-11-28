/** The lids close by turning about the eyeball's lateral axis: per vertex, how far each lid's skin turns. */

import * as THREE from 'three'
import { vertexField } from './graph.js'
import type { Tissue } from './tissue.js'

const LATERAL = new THREE.Vector3(0, 0, 1)

/**
 * Per eye, the upper and lower lid's closing angle per vertex (radians): exact on the rim, where the lids meet a quarter
 * of the way down their gap, 0 on the surrounding face, harmonic between.
 */
function lidAngles(tissue: Tissue): { upper: Float32Array; lower: Float32Array }[] {
  const { rest, graph, anatomy, rims } = tissue
  return anatomy.eyes.map((eye, e) => {
    const c = eye.center
    const q = new THREE.Vector3()
    const active = new Uint8Array(graph.adj.length)
    const far = new Set<number>()
    for (let v = 0; v < rest.length / 3; v++) {
      q.fromArray(rest, v * 3)
      const d = q.distanceTo(c)
      if (d > 0.02907) continue
      active[graph.node[v]] = 1
      if (d > 0.02089 || q.x < c.x - 0.00363 || q.y > c.y + 0.01181 || q.y < c.y - 0.0109) far.add(graph.node[v])
    }
    const p = (v: number) => new THREE.Vector3().fromArray(rest, v * 3)
    const elevation = (v: number) => Math.atan2(p(v).y - c.y, p(v).x - c.x)
    const isUpper = (v: number) => p(v).y > c.y + 0.00073 || (Math.abs(p(v).z - c.z) < eye.innerHalfWidth * 0.5 && p(v).y > c.y)
    const rim = rims[e]
    const uppers = rim.filter(isUpper), lowers = rim.filter((v) => !isUpper(v))
    if (!uppers.length || !lowers.length) throw new Error('face: an eye opening has no upper or no lower lid; check the lid landmarks')
    const nearest = (v: number, list: number[]) => {
      const z = p(v).z
      return list.reduce((a, b) => (Math.abs(p(b).z - z) < Math.abs(p(a).z - z) ? b : a))
    }
    const meet = (u: number, l: number) => elevation(l) + 0.25 * (elevation(u) - elevation(l))
    const solve = (upper: boolean) => {
      const fixed = new Map<number, number>()
      for (const n of far) fixed.set(n, 0)
      for (const v of uppers) fixed.set(graph.node[v], upper ? Math.max(0, elevation(v) - meet(v, nearest(v, lowers)) + 0.05) : 0)
      for (const v of lowers) fixed.set(graph.node[v], upper ? 0 : Math.max(0, meet(nearest(v, uppers), v) - elevation(v)))
      return vertexField(graph, fixed, active, 3000)
    }
    return { upper: solve(true), lower: solve(false) }
  })
}

/** eyeBlink (lids closed) and eyeWide (upper lid raised) per side, as template-space deltas. */
export function lidShapes(tissue: Tissue): Record<string, Float32Array> {
  const angles = lidAngles(tissue)
  const shape = (e: number, blink: number) => {
    const { center } = tissue.anatomy.eyes[e]
    const { upper, lower } = angles[e]
    const out = new Float32Array(tissue.rest.length)
    const v = new THREE.Vector3()
    for (let i = 0; i < upper.length; i++) {
      if (!upper[i] && !lower[i]) continue
      v.fromArray(tissue.rest, i * 3).sub(center)
      v.applyAxisAngle(LATERAL, -blink * upper[i]).applyAxisAngle(LATERAL, Math.max(0, blink) * lower[i]).add(center)
      for (let k = 0; k < 3; k++) out[i * 3 + k] = v.getComponent(k) - tissue.rest[i * 3 + k]
    }
    return out
  }
  return { eyeBlinkLeft: shape(0, 1), eyeBlinkRight: shape(1, 1), eyeWideLeft: shape(0, -0.3), eyeWideRight: shape(1, -0.3) }
}
