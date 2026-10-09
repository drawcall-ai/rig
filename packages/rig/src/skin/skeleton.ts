/**
 * Skeleton input: a flat list of named bones in world space, linked by parent
 * name. A bone with a child bone and no pieces deforms: its segment from its
 * joint to its first child's joint attracts skin weights.
 */

import { distance, type Vec3 } from '../vec3.js'
import { MAX_BONES_PER_SOLVE, type BoneLine } from './solve.js'

export interface SkeletonBone {
  name: string
  /** Name of the parent bone; omit for a root. */
  parent?: string
  /** Joint (pivot) position in world space. */
  position: Vec3
  /**
   * Rigid attachments: indices of separate mesh pieces (see meshPieces) bound 100% to this bone,
   * e.g. glasses, a helmet, armor plates, a prop. A bone with pieces drives only them.
   */
  pieces?: number[]
}

export interface ResolvedBone extends SkeletonBone {
  parentIndex: number
  children: number[]
  /** End of the segment: the first child's joint (the joint itself for a leaf). */
  tail: Vec3
  /** Attracts weights along its segment; false for end bones and bones with pieces. */
  deform: boolean
}

/** Validates the bones and resolves parents, children, segment ends and which bones deform. */
export function resolveSkeleton(bones: SkeletonBone[]): ResolvedBone[] {
  if (bones.length > MAX_BONES_PER_SOLVE) throw new Error(`skeleton has ${bones.length} bones, max ${MAX_BONES_PER_SOLVE}`)

  const indexOf = new Map<string, number>()
  for (const [i, bone] of bones.entries()) {
    if (bone.name === '') throw new Error(`bones[${i}] has no name`)
    // three.js (and other animation systems) reserve these in property paths and rename such nodes
    if (/[\s.:/\[\]]/.test(bone.name)) {
      throw new Error(`bone name "${bone.name}" contains whitespace or one of . : / [ ]; use e.g. "arm_L"`)
    }
    if (indexOf.has(bone.name)) throw new Error(`duplicate bone name "${bone.name}"`)
    indexOf.set(bone.name, i)
    assertVec3(bone.position, `bone "${bone.name}".position`)
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
    tail: children[i].length ? bones[children[i][0]].position : bone.position,
    deform: children[i].length > 0 && bone.pieces === undefined,
  }))
  if (!resolved.some((bone) => bone.deform)) throw new Error('skeleton has no deforming bone (end bones and bones with pieces do not count)')
  return resolved
}

export function boneLines(bones: ResolvedBone[]): BoneLine[] {
  // A deforming bone always has a child, so no line is terminal
  return bones.flatMap((bone, boneIndex) => (bone.deform ? [{ start: bone.position, end: bone.tail, boneIndex, isTerminal: false }] : []))
}

/** Length of the bone's segment, joint to tail. */
export function boneLength(bone: ResolvedBone): number {
  return distance(bone.position, bone.tail)
}

function assertVec3(value: Vec3, what: string): void {
  if (!value.every(Number.isFinite)) throw new Error(`${what} must be finite [x, y, z] numbers, got ${JSON.stringify(value)}`)
}
