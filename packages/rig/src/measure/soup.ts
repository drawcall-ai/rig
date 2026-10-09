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
    for (let i = 0; i < count; i++) indices.push(offsets[m] + (index ? index.getX(i) : i))
  })
  return { meshes, offsets, positions, indices: new Uint32Array(indices) }
}
