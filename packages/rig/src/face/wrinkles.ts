import * as THREE from 'three'
import { FACE_REST, FACE_MATERIAL, isFaceData } from './contract.js'

/**
 * Replaces the face material of every face rigged by CachedRigLoader under `object` with a node material carrying expression
 * wrinkles: forehead lines, frown furrows, nose wrinkles, crow's feet, the lower-lid crease, the nasolabial fold, the
 * chin crease and the cheek mass's roundness. They follow the morph weights each frame on their own. The face material must
 * be a MeshStandardMaterial. Needs three's WebGPURenderer; it loads `three/webgpu` only when called.
 */
export async function wrinkles(object: THREE.Object3D): Promise<void> {
  const { wrinkled } = await import('./wrinkles/material.js')
  let found = 0
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.geometry.getAttribute(FACE_REST)) return
    const data: unknown = node.geometry.userData.face
    if (!isFaceData(data)) throw new Error(`wrinkles: mesh "${node.name}" has face positions but no valid face data`)
    // a GLB reload splits the face into one mesh per material, so only some of them hold the face material
    const materials = [node.material].flat().map((material) => {
      if (!material.userData[FACE_MATERIAL]) return material
      // the wrinkles shade through the standard lighting model, which no other material maps onto faithfully
      if (!(material instanceof THREE.MeshStandardMaterial) || material instanceof THREE.MeshPhysicalMaterial) throw new Error(`wrinkles: the face material of "${node.name}" is a ${material.type}; wrinkles() needs a MeshStandardMaterial`)
      found++
      return wrinkled(material, data, node)
    })
    node.material = Array.isArray(node.material) ? materials : materials[0]
  })
  if (!found) throw new Error('wrinkles: no rigged face under this object')
}
