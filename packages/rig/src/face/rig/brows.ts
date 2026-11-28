/**
 * Brow controls: the brow skin around each inner and outer brow landmark moves as a unit, fading harmonically to the
 * still scalp a little past the hairline, the eye rims and cheeks. They move the brow itself, which the template's
 * subtle brow shapes barely do.
 */

import * as THREE from 'three'
import { vertexField } from './graph.js'
import type { Landmark } from './landmarks.js'
import type { Tissue } from './tissue.js'

type Control = 'browInnerLeft' | 'browInnerRight' | 'browOuterLeft' | 'browOuterRight'
type Move = [Control, [number, number, number]]

/** How each brow shape moves the controls (template meters). */
const MOVES: Record<string, Move[]> = {
  browInnerUp: [['browInnerLeft', [0.00091, 0.00654, 0.00073]], ['browInnerRight', [0.00091, 0.00654, -0.00073]]],
  browOuterUpLeft: [['browOuterLeft', [0, 0.00581, 0]]],
  browOuterUpRight: [['browOuterRight', [0, 0.00581, 0]]],
  browDownLeft: [['browInnerLeft', [0.00073, -0.00327, 0.00218]], ['browOuterLeft', [0, -0.00145, 0]]],
  browDownRight: [['browInnerRight', [0.00073, -0.00327, -0.00218]], ['browOuterRight', [0, -0.00145, 0]]],
}

const CONTROLS: Control[] = ['browInnerLeft', 'browInnerRight', 'browOuterLeft', 'browOuterRight']
const STILL: Landmark[] = ['cheekLeft', 'cheekRight']
/** How far past the hairline the brows still move the skin: the frontalis carries it up and eases into the still scalp. */
const SCALP = 0.0145

/** Per brow shape, the deltas its controls make. */
export function browShapes(tissue: Tissue): Record<string, Float32Array> {
  const { rest, graph, anatomy, mouth, rims } = tissue
  const { eyeY } = anatomy
  const wingY = anatomy.mirrored('noseWing').y
  const centers = new Map([...CONTROLS, ...STILL].map((name) => [name, anatomy.point(name)]))
  const q = new THREE.Vector3()
  const active = new Uint8Array(graph.adj.length)
  const far = new Set<number>(rims.flat().map((v) => graph.node[v]))
  const seeds = new Map<Landmark, Set<number>>([...centers.keys()].map((name) => [name, new Set<number>()]))
  for (let v = 0; v < rest.length / 3; v++) {
    q.fromArray(rest, v * 3)
    const hairline = anatomy.hairline(q.z)
    if (Math.abs(q.z) > 0.08175 || q.y < eyeY - 0.0639 || q.y > hairline + 2 * SCALP || q.x < -0.0066) continue
    const n = graph.node[v]
    active[n] = 1
    if (q.y > hairline + SCALP || q.y < wingY - 0.006 || Math.abs(q.z) > 0.0654 || q.x < 0.0388 || v >= mouth.cavityStart) { far.add(n); continue }
    for (const [name, c] of centers) if (q.distanceTo(c) < (name.startsWith('cheek') ? 0.0109 : 0.00999)) seeds.get(name)?.add(n)
  }
  const fields = new Map(CONTROLS.map((control) => {
    const fixed = new Map<number, number>()
    for (const n of far) fixed.set(n, 0)
    for (const [name, set] of seeds) for (const n of set) fixed.set(n, name === control ? 1 : 0)
    return [control, vertexField(graph, fixed, active, 3000)]
  }))
  return Object.fromEntries(Object.entries(MOVES).map(([shape, moves]) => {
    const out = new Float32Array(rest.length)
    for (const [control, [x, y, z]] of moves) {
      const field = fields.get(control)
      if (!field) throw new Error(`face: no field for ${control}`)
      for (let v = 0; v < field.length; v++) {
        out[v * 3] += x * field[v]
        out[v * 3 + 1] += y * field[v]
        out[v * 3 + 2] += z * field[v]
      }
    }
    return [shape, out]
  }))
}
