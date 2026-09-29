/**
 * @drawcall/skinning: automatic skin weights for glTF, on the CPU, in Node and
 * the browser. Works on @gltf-transform/core Documents; reading and writing
 * files is the caller's (see the CLI in cli.ts, or WebIO in a browser).
 */

import type { Document } from '@gltf-transform/core'
import { readScene } from './scene.js'
import { computeVoxelVolume, type VoxelVolume, type VoxelVolumeOptions } from './voxelize.js'

export { skin, type BoneReport, type SkinOptions, type SkinReport } from './skin.js'
export type { Skeleton, SkeletonBone } from './skeleton.js'
export { formatVolume, sliceRegions, type Axis, type Slice, type SliceRegion, type SliceResult } from './views.js'
export { computeVoxelVolume, type VoxelVolume, type VoxelVolumeOptions } from './voxelize.js'
export { solveSkinWeights, type BoneLine, type SolveInput, type SolveResult, type Vec3 } from './solve.js'

/** Solid voxel volume of every mesh in the document's default scene, in world space. */
export function voxelize(document: Document, options: VoxelVolumeOptions = {}): VoxelVolume {
  const { positions, indices } = readScene(document)
  return computeVoxelVolume(positions, indices, options)
}
