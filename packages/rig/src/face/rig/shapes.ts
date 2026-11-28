/**
 * The face's final shape set: the transferred ARKit shapes, corrected where a template transfer misreads a face, plus
 * the face's own lids.
 */

import * as THREE from 'three'
import { browShapes } from './brows.js'
import { CHEEK_MASS } from '../mass.js'
import { cheekMass, cheekSwell } from './cheek.js'
import { smoothstep } from './math.js'
import { lidShapes } from './lids.js'
import type { Tissue } from './tissue.js'
import { jawMotion } from './transfer.js'

/** The template's upper face moves far less than a real one (brows ~1 mm): gains toward an anatomical range. */
const GAIN: [RegExp, number][] = [[/^brow/, 1.5], [/^noseSneer/, 1.2], [/^mouthFrown/, 1.4]]
const BROW_CONTROL = 1.1

export interface Shape {
  /** Template-space deltas of the face skin. */
  delta: Float32Array
  /** The jaw's rigid motion under it, which the lower teeth and tongue follow. */
  jaw: THREE.Matrix4
}

export function faceShapes(tissue: Tissue, transferred: Record<string, Float32Array>, rest: Float32Array, restNormals: Float32Array): Record<string, Shape> {
  const { anatomy } = tissue
  const count = rest.length / 3
  const rimFade = rimDistanceFade(tissue)
  const brows = browShapes(tissue)
  const wing = anatomy.mirrored('noseWing')
  const { eyeY } = anatomy
  const shapes: Record<string, Shape> = {}
  const moving = (delta: Float32Array): Shape => ({ delta, jaw: jawMotion(delta, tissue) })
  // each side's cheek swelling, shared between the shapes that carry it
  const swelling: Record<string, Float32Array> = {}
  for (const [side, sign] of [['Left', -1], ['Right', 1]] as const) {
    const swell = cheekSwell(tissue, restNormals, rimFade, sign)
    for (const [base, share] of Object.entries(CHEEK_MASS.swell)) swelling[`${base}${side}`] = swell.map((x) => x * share)
  }
  for (const [name, source] of Object.entries(transferred)) {
    const gain = GAIN.find(([pattern]) => pattern.test(name))?.[1] ?? 1
    const brow = name.startsWith('brow')
    // amplified brows must not pull the lids off the eyeballs
    const d = source.map((x, i) => x * (1 + (gain - 1) * (brow ? rimFade[Math.floor(i / 3)] : 1)))
    const control = brows[name]
    if (control) for (let i = 0; i < d.length; i++) d[i] += control[i] * BROW_CONTROL * rimFade[Math.floor(i / 3)]
    const side = name.endsWith('Left') ? -1 : 1
    for (let v = 0; v < count; v++) {
      const y = rest[v * 3 + 1], z = rest[v * 3 + 2]
      let k = 1, ky = 1
      // the template's upper-lip raise drags the nostril base along: keep the nose mostly still
      if (name.startsWith('mouthUpperUp')) k = 1 - 0.75 * smoothstep(0, 1, (y - (wing.y - 0.0097)) / 0.0109) * (1 - Math.min(1, Math.max(0, (Math.abs(z - anatomy.mouth.center.z) - (wing.z + 0.0032)) / 0.00727)))
      // a real cheek mostly swells rather than rises: the transferred raise gives way to the swelling added below
      if (/^(mouthSmile|cheekSquint)/.test(name)) {
        const m = cheekMass(anatomy.cheek, y, z, side)
        k = 1 - (name.startsWith('cheekSquint') ? 0.5 : 0) * m
        ky = 1 - 0.65 * m
      }
      // the transfer smears the lid squint down the cheek: keep it to the lids
      if (name.startsWith('eyeSquint')) k = smoothstep(0, 1, (y - (eyeY - 0.01998)) / 0.0109)
      d[v * 3] *= k; d[v * 3 + 1] *= k * ky; d[v * 3 + 2] *= k
    }
    const swell = swelling[name]
    if (swell) for (let i = 0; i < d.length; i++) d[i] += swell[i]
    shapes[name] = moving(d)
  }
  for (const [name, delta] of Object.entries(lidShapes(tissue))) shapes[name] = { delta, jaw: new THREE.Matrix4() }
  return shapes
}

/** 0 at the eye rims, rising to 1 a few millimeters away. */
function rimDistanceFade({ rest, rims }: Tissue): Float32Array {
  const rim = rims.flat().map((v) => new THREE.Vector3().fromArray(rest, v * 3))
  const out = new Float32Array(rest.length / 3)
  const p = new THREE.Vector3()
  for (let v = 0; v < out.length; v++) {
    p.fromArray(rest, v * 3)
    let nearest = Infinity
    for (const r of rim) nearest = Math.min(nearest, p.distanceToSquared(r))
    out[v] = smoothstep(0, 1, (Math.sqrt(nearest) - 0.00363) / 0.00727)
  }
  return out
}
