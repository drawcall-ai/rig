/** Posing a skinned scene. Every pose starts from the bind pose, so a pose means the same thing each time. */

import * as THREE from 'three'
import type { Vec3 } from './vec3.js'
import { restMatrix, saveRest } from './skin/rest.js'

export interface Pose {
  /** Euler XYZ in radians per bone, in the bone's bind frame: applied on top of its bind rotation. */
  rotations?: Record<string, Vec3>
  /** World point per bone: after its rotation, the bone turns so its segment (joint to first child bone) points there. */
  targets?: Record<string, Vec3>
}

/**
 * Resets the scene's skeletons to the bind pose, then, parents first, rotates each named bone and turns it
 * toward its target. Rig-created bones retain local bind transforms through clones and glTF export,
 * so changing the asset's placement does not change its pose. For native glTF without that metadata,
 * pass the loaded scene root (initially identity); its current world matrix supplies host placement.
 * A scene without skeletons has no bind pose: it is left as it is, and posing it throws.
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

  object.updateWorldMatrix(true, false)
  object.updateMatrixWorld(true)
  const rest = new Map(bones.map((bone) => [bone, restMatrix(bone)]))
  const worldBind = new Map<THREE.Bone, THREE.Matrix4>()
  for (const skeleton of skeletons) skeleton.bones.forEach((bone, index) => {
    const inverse = skeleton.boneInverses[index]
    if (!inverse) throw new Error(`bone "${bone.name}" has no inverse bind matrix`)
    worldBind.set(bone, inverse.clone().invert())
  })
  const placement = object.matrixWorld.clone()
  for (const bone of bones) {
    const local = rest.get(bone)
    if (local) bone.matrix.copy(local)
    else {
      const bind = worldBind.get(bone)
      if (!bind) throw new Error(`bone "${bone.name}" has no bind matrix`)
      bone.matrix.multiplyMatrices(placement, bind)
      if (bone.parent) bone.matrix.premultiply(bone.parent.matrixWorld.clone().invert())
    }
    bone.matrix.decompose(bone.position, bone.quaternion, bone.scale)
    bone.updateMatrixWorld(true)
    if (!local) saveRest(bone)
  }
  for (const bone of bones) {
    const rotation = rotations?.[bone.name]
    const target = targets?.[bone.name]
    if (rotation) bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)))
    if (target) aim(bone, new THREE.Vector3(...target))
    if (rotation || target) bone.updateMatrixWorld(true)
  }
}

/** Turns a bone by the shortest rotation so the segment to its first child bone points at a world point. */
function aim(bone: THREE.Bone, target: THREE.Vector3): void {
  const child = bone.children.find((node) => node instanceof THREE.Bone)
  if (!child) throw new Error(`pose target on "${bone.name}": it has no child bone, so no segment to point`)
  bone.updateMatrixWorld(true)
  const joint = bone.getWorldPosition(new THREE.Vector3())
  const end = child.getWorldPosition(new THREE.Vector3())
  const destination = target.clone()
  // Solve in the parent's coordinates so its nonuniform scale also affects the target correctly.
  if (bone.parent) {
    const inverse = bone.parent.matrixWorld.clone().invert()
    joint.applyMatrix4(inverse)
    end.applyMatrix4(inverse)
    destination.applyMatrix4(inverse)
  }
  const from = end.sub(joint)
  const to = destination.sub(joint)
  if (to.lengthSq() === 0) throw new Error(`pose target on "${bone.name}" is its own joint`)
  if (from.lengthSq() === 0) throw new Error(`pose target on "${bone.name}": its segment has zero length`)
  bone.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize()))
}
