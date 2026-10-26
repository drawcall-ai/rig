import * as THREE from 'three'
import type { Vec3 } from './vec3.js'
import { resolveSkeleton, type SkeletonBone } from './skin/skeleton.js'

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

/**
 * The bone tree a serialized skeleton describes, ready for skin(): one bone() per entry at its absolute
 * position, linked by parent name, with a copy of its `pieces` in `userData.pieces`. Validates the skeleton
 * as skin() does and requires exactly one root. `byName` is keyed by the skeleton's bone names.
 */
export function bones<Name extends string>(
  skeleton: readonly SkeletonBone<Name>[],
): { root: THREE.Bone; byName: Record<Name, THREE.Bone> } {
  const resolved = resolveSkeleton(skeleton)
  const roots = resolved.filter((entry) => entry.parentIndex < 0)
  if (roots.length !== 1) throw new Error(`skeleton must have exactly one root, got ${roots.length}`)
  const byName: Partial<Record<Name, THREE.Bone>> = {}
  const built = skeleton.map((entry) => {
    const result = bone(entry.name, entry.position)
    if (entry.pieces) result.userData.pieces = entry.pieces.slice()
    byName[entry.name] = result
    return result
  })
  resolved.forEach((entry, index) => {
    if (entry.parentIndex >= 0) built[entry.parentIndex].attach(built[index])
  })
  if (!covers(byName, skeleton)) throw new Error('bones() left a bone out of byName')
  return { root: built[resolved.indexOf(roots[0])], byName }
}

/** Narrows byName to every name of the skeleton, checked. */
function covers<Name extends string>(
  byName: Partial<Record<Name, THREE.Bone>>,
  skeleton: readonly SkeletonBone<Name>[],
): byName is Record<Name, THREE.Bone> {
  return skeleton.every((entry) => byName[entry.name] !== undefined)
}
