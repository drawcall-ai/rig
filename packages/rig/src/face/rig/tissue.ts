/** The cut face surface at rest, with the regions every shape step consults. */

import * as THREE from 'three'
import type { Anatomy } from './anatomy.js'
import { surfaceGraph, type SurfaceGraph } from './graph.js'
import { smoothstep } from './math.js'
import type { Mouth } from './mouth.js'
import type { Surface } from './surface.js'

export interface Tissue {
  /** Template-space rest positions. */
  rest: Float32Array
  triangles: Uint32Array
  /** Topological ids: equal across seams, distinct across the cuts. */
  topo: Int32Array
  graph: SurfaceGraph
  anatomy: Anatomy
  mouth: Mouth
  /** Rim vertices of each eye opening, left then right. */
  rims: number[][]
  /** How rigidly the jaw carries each vertex: 1 on the jaw core below the mouth, graded across the lip line in the cavity, else 0. */
  jaw: Float32Array
  /**
   * How much the skin at a point may move: 1 on the face, easing to 0 at the hair and the back and sides of the head,
   * which stay still, so the moving face meets them without a crease.
   */
  mobility: (p: THREE.Vector3) => number
}

/** How far the skin eases to still before the hair and the back and sides of the head. */
const EASE = 0.0073

export function restTissue(s: Surface, anatomy: Anatomy, mouth: Mouth, rims: number[][]): Tissue {
  const rest = Float32Array.from(s.positions)
  const topo = Int32Array.from(s.topo)
  const geometry = new THREE.BufferGeometry()
  geometry.setIndex(s.triangles)
  const { center, line } = anatomy.mouth
  // the neck's front plane: what lies behind it belongs to the neck, not the jaw
  const throat = center.clone().add(new THREE.Vector3(-0.0539, -0.0733, 0))
  const neck = new THREE.Vector3(0.5, 0.86, 0).normalize()
  const jaw = new Float32Array(rest.length / 3)
  const p = new THREE.Vector3()
  for (let v = 0; v < jaw.length; v++) {
    p.fromArray(rest, v * 3)
    const below = line(p.z) - p.y
    if (v >= mouth.cavityStart) jaw[v] = Math.min(1, Math.max(0, 0.5 + below / 0.00727))
    else if (below > 0.00273 && Math.abs(p.z - center.z) < 0.02 + 1.2 * (below - 0.00273) && p.x > center.x - 0.065 && p.clone().sub(throat).dot(neck) > 0.0182) jaw[v] = 1
  }
  return {
    rest, triangles: Uint32Array.from(s.triangles), topo, graph: surfaceGraph(geometry, topo), anatomy, mouth, rims, jaw,
    mobility: (q) => {
      const hairline = anatomy.hairline(q.z) - 0.00091
      const below = 1 - smoothstep(hairline - EASE, hairline, q.y)
      const front = 1 - smoothstep(0.0618 - EASE, 0.0618, Math.abs(q.z)) * smoothstep(1.6053 - EASE, 1.6053, q.y)
      return below * front * smoothstep(-0.0066, -0.0066 + EASE, q.x)
    },
  }
}

/** Vertex normals accumulated per topological id, so seams do not crease while the cuts stay split. */
export function normals({ triangles, topo }: Tissue, positions: Float32Array): Float32Array {
  const sum = new Float32Array(positions.length)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let t = 0; t < triangles.length; t += 3) {
    a.fromArray(positions, triangles[t] * 3)
    b.fromArray(positions, triangles[t + 1] * 3)
    c.fromArray(positions, triangles[t + 2] * 3)
    const n = b.sub(a).cross(c.sub(a))
    for (let k = 0; k < 3; k++) {
      const id = topo[triangles[t + k]]
      sum[id * 3] += n.x; sum[id * 3 + 1] += n.y; sum[id * 3 + 2] += n.z
    }
  }
  const out = new Float32Array(positions.length)
  const n = new THREE.Vector3()
  for (let v = 0; v < topo.length; v++) n.fromArray(sum, topo[v] * 3).normalize().toArray(out, v * 3)
  return out
}
