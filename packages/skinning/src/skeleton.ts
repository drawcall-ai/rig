/**
 * Skeleton input: a flat list of named bones in the glTF's world space,
 * linked by parent name. Each deforming bone becomes a line segment from its
 * joint to its tail that attracts skin weights.
 */

import { MAX_BONES_PER_SOLVE, type BoneLine, type Vec3 } from './solve.js'

export interface SkeletonBone {
  name: string
  /** Name of the parent bone; omit for a root. */
  parent?: string
  /** Joint (pivot) position in world space. */
  position: Vec3
  /**
   * Where the bone ends. Default: the first child's position; for a leaf, the
   * joint extended by half the parent->joint vector.
   */
  tail?: Vec3
  /** false = the joint exists in the output but attracts no weights (default true). */
  deform?: boolean
}

export interface Skeleton {
  bones: SkeletonBone[]
}

export interface ResolvedBone extends SkeletonBone {
  parentIndex: number
  children: number[]
  tail: Vec3
  deform: boolean
}

/** Validates the skeleton and resolves parents, children and tails. */
export function resolveSkeleton(skeleton: Skeleton): ResolvedBone[] {
  const bones = skeleton?.bones
  if (!Array.isArray(bones) || bones.length === 0) throw new Error('skeleton.bones must be a non-empty array')
  if (bones.length > MAX_BONES_PER_SOLVE) throw new Error(`skeleton has ${bones.length} bones, max ${MAX_BONES_PER_SOLVE}`)

  const indexOf = new Map<string, number>()
  for (const [i, bone] of bones.entries()) {
    if (typeof bone.name !== 'string' || bone.name === '') throw new Error(`bones[${i}].name must be a non-empty string`)
    if (indexOf.has(bone.name)) throw new Error(`duplicate bone name "${bone.name}"`)
    indexOf.set(bone.name, i)
    assertVec3(bone.position, `bone "${bone.name}".position`)
    if (bone.tail !== undefined) assertVec3(bone.tail, `bone "${bone.name}".tail`)
  }

  const parentIndices = bones.map((bone) => {
    if (bone.parent === undefined) return -1
    const index = indexOf.get(bone.parent)
    if (index === undefined) throw new Error(`bone "${bone.name}" has unknown parent "${bone.parent}"`)
    return index
  })
  for (let i = 0; i < bones.length; i++) {
    const seen = new Set<number>()
    for (let j = i; j >= 0; j = parentIndices[j]) {
      if (seen.has(j)) throw new Error(`bone "${bones[i].name}" is part of a parent cycle`)
      seen.add(j)
    }
  }

  const children = bones.map((): number[] => [])
  parentIndices.forEach((parent, i) => parent >= 0 && children[parent].push(i))

  const resolved = bones.map((bone, i): ResolvedBone => ({
    ...bone,
    parentIndex: parentIndices[i],
    children: children[i],
    tail: bone.tail ?? defaultTail(bones, parentIndices[i], children[i], bone.position),
    deform: bone.deform !== false,
  }))
  if (!resolved.some((bone) => bone.deform)) throw new Error('skeleton has no deforming bone')
  return resolved
}

export function boneLines(bones: ResolvedBone[]): BoneLine[] {
  return bones.flatMap((bone, boneIndex) =>
    bone.deform ? [{ start: bone.position, end: bone.tail, boneIndex, isTerminal: bone.children.length === 0 }] : [],
  )
}

function defaultTail(bones: SkeletonBone[], parent: number, children: number[], position: Vec3): Vec3 {
  if (children.length > 0) return bones[children[0]].position
  if (parent < 0) return position
  const from = bones[parent].position
  return [
    position[0] + (position[0] - from[0]) * 0.5,
    position[1] + (position[1] - from[1]) * 0.5,
    position[2] + (position[2] - from[2]) * 0.5,
  ]
}

function assertVec3(value: unknown, what: string): void {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`${what} must be [x, y, z] numbers, got ${JSON.stringify(value)}`)
  }
}
