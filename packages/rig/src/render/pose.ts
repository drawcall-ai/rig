/** Posing a skinned scene. Every pose starts from the bind pose, so a pose means the same thing each time. */

import * as THREE from 'three'
import type { Vec3 } from '../vec3.js'

export interface Pose {
  /** Euler XYZ in radians per bone, in the bone's bind frame: applied on top of its bind rotation. */
  rotations?: Record<string, Vec3>
  /** World point per bone: after its rotation, the bone turns so its segment (joint to first child bone) points there. */
  targets?: Record<string, Vec3>
}

/**
 * Resets the scene's skeletons to the bind pose, then, parents first, rotates each named bone and turns it
 * toward its target. A scene without skeletons has no bind pose: it is left as it is, and posing it throws.
 */
export function pose(object: THREE.Object3D, { rotations, targets }: Pose): void {
  const skeletons = new Set<THREE.Skeleton>()
  object.traverse((node) => node instanceof THREE.SkinnedMesh && skeletons.add(node.skeleton))
  if (skeletons.size === 0) {
    if (rotations || targets) throw new Error('posing needs a skinned scene; call skin() first')
    return
  }
  const inSkeleton = new Set([...skeletons].flatMap((skeleton) => skeleton.bones))
  // Traversal order puts parents first, which skeleton order does not promise
  const bones: THREE.Bone[] = []
  object.traverse((node) => node instanceof THREE.Bone && inSkeleton.has(node) && bones.push(node))
  const names = new Set(bones.map((bone) => bone.name))
  for (const name of [...Object.keys(rotations ?? {}), ...Object.keys(targets ?? {})])
    if (!names.has(name)) throw new Error(`pose names unknown bone "${name}"`)

  // Like Skeleton.pose(), but always relative to the bone's actual parent: three.js takes a root bone's
  // bind world matrix as its local one, which is wrong under a transformed armature node
  object.updateMatrixWorld(true)
  for (const skeleton of skeletons) skeleton.bones.forEach((bone, i) => bone.matrixWorld.copy(skeleton.boneInverses[i]).invert())
  for (const bone of bones) {
    bone.matrix.copy(bone.matrixWorld)
    if (bone.parent) bone.matrix.premultiply(bone.parent.matrixWorld.clone().invert())
    bone.matrix.decompose(bone.position, bone.quaternion, bone.scale)
  }
  object.updateMatrixWorld(true)
  for (const bone of bones) {
    const rotation = rotations?.[bone.name]
    const target = targets?.[bone.name]
    if (rotation) bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)))
    if (target) aim(bone, new THREE.Vector3(...target))
    if (rotation || target) bone.updateMatrixWorld(true)
  }
}

/** Records the local transform of every bone under the object; the returned function puts them back. */
export function snapshot(object: THREE.Object3D): () => void {
  const bones: THREE.Bone[] = []
  object.traverse((node) => node instanceof THREE.Bone && bones.push(node))
  const saved = bones.map((bone) => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() }))
  return () =>
    bones.forEach((bone, i) => {
      bone.position.copy(saved[i].position)
      bone.quaternion.copy(saved[i].quaternion)
      bone.scale.copy(saved[i].scale)
    })
}

/** Turns a bone by the shortest rotation so the segment to its first child bone points at a world point. */
function aim(bone: THREE.Bone, target: THREE.Vector3): void {
  const child = bone.children.find((node) => node instanceof THREE.Bone)
  if (!child) throw new Error(`pose target on "${bone.name}": it has no child bone, so no segment to point`)
  bone.updateMatrixWorld(true)
  const joint = bone.getWorldPosition(new THREE.Vector3())
  const from = child.getWorldPosition(new THREE.Vector3()).sub(joint)
  const to = target.clone().sub(joint)
  if (to.lengthSq() === 0) throw new Error(`pose target on "${bone.name}" is its own joint`)
  const turn = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize())
  // The turn is in world space; in the parent's frame it is parent^-1 * turn * parent
  const parent = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion()
  bone.quaternion.premultiply(parent.clone().invert().multiply(turn).multiply(parent))
}
