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
  object.updateWorldMatrix(true, false)
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
    const mirrored = mesh.matrixWorld.determinant() < 0
    for (let i = 0; i < count; i++) {
      const corner = outward(i, mirrored)
      indices.push(offsets[m] + (index ? index.getX(corner) : corner))
    }
  })
  return { meshes, offsets, positions, indices: new Uint32Array(indices) }
}

/**
 * The index position to read for corner `i` of a triangle list: a mirroring transform turns triangles
 * inside out, so under one the last two corners of each triangle swap to keep them facing outward.
 */
export function outward(i: number, mirrored: boolean): number {
  return mirrored ? i - (i % 3) + [0, 2, 1][i % 3] : i
}
