/** The meshes of a scene as one world-space triangle soup: what section, pick, pieces and skin measure. */

import * as THREE from 'three'

export interface Soup {
  meshes: THREE.Mesh[]
  /** First vertex of each mesh in `positions`. */
  offsets: number[]
  positions: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
}

/** World-space positions of every vertex of every mesh (skinned meshes in their current pose). */
export function gather(object: THREE.Object3D): Soup {
  object.updateMatrixWorld(true)
  const meshes: THREE.Mesh[] = []
  object.traverse((node) => node instanceof THREE.Mesh && meshes.push(node))
  if (meshes.length === 0) throw new Error('no meshes under this object')
  const offsets: number[] = []
  let total = 0
  for (const mesh of meshes) {
    offsets.push(total)
    total += mesh.geometry.getAttribute('position').count
  }
  const positions = new Float32Array(total * 3)
  const indices: number[] = []
  const v = new THREE.Vector3()
  meshes.forEach((mesh, m) => {
    const position = mesh.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i)
      if (mesh instanceof THREE.SkinnedMesh) mesh.applyBoneTransform(i, v)
      v.applyMatrix4(mesh.matrixWorld).toArray(positions, (offsets[m] + i) * 3)
    }
    const index = mesh.geometry.getIndex()
    const count = index ? index.count : position.count
    // A mirroring transform turns the triangles inside out; swapping two corners keeps them facing outward
    const corners = mesh.matrixWorld.determinant() < 0 ? [0, 2, 1] : [0, 1, 2]
    for (let i = 0; i < count; i++) {
      const corner = i - (i % 3) + corners[i % 3]
      indices.push(offsets[m] + (index ? index.getX(corner) : corner))
    }
  })
  return { meshes, offsets, positions, indices: new Uint32Array(indices) }
}

/**
 * For each vertex, the first vertex at its position: seams split vertices that one surface shares.
 * Positions match exactly, or, given a `step`, when they snap to the same point of a grid that fine
 * (two points closer than `step` can still straddle a grid line).
 */
export function weld(positions: Float32Array, step = 0): Int32Array {
  const count = positions.length / 3
  const first = new Int32Array(count)
  const byPosition = new Map<string, number>()
  const snap = (value: number) => (step > 0 ? Math.round(value / step) : value)
  for (let v = 0; v < count; v++) {
    const key = `${snap(positions[v * 3])},${snap(positions[v * 3 + 1])},${snap(positions[v * 3 + 2])}`
    const known = byPosition.get(key)
    if (known === undefined) byPosition.set(key, v)
    first[v] = known ?? v
  }
  return first
}
