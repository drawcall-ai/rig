/**
 * The three.js-native core, usable in Node and the browser: measure a scene
 * (section, pieces) and bind it to a THREE.Bone tree (skin). Bones are plain
 * three.js: new THREE.Bone(), place it with position.set(worldX, worldY,
 * worldZ), then parent.attach(bone) keeps that world position. Pose with
 * bone.rotation.
 *
 * A bone's segment runs from its joint to its first child. Leaf bones only
 * mark where a chain ends (like Mixamo's HeadTop_End) and get no weights.
 * bone.userData.pieces = [i, ...] binds those separate mesh pieces (indices
 * from pieces()) 100% to the bone, which then drives only them.
 */

import * as THREE from 'three'
import type { Vec3 } from './vec3.js'

export { pieces, type Piece } from './measure/pieces.js'
export { section, type Axis, type Plane, type Region, type Section } from './measure/section.js'
export { skin } from './skin/bind.js'
export type { BoneReport, SkinReport } from './skin/weights.js'

/**
 * A THREE.Bone named `name` with its joint at `world` (world space), attached under `parent` if given
 * (parent.attach keeps the world position). The same as doing it by hand; it saves three lines per bone.
 */
export function bone(name: string, world: Vec3, parent?: THREE.Bone): THREE.Bone {
  const b = new THREE.Bone()
  b.name = name
  b.position.set(...world)
  parent?.attach(b)
  return b
}
