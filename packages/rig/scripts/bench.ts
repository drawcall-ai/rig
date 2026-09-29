/**
 * Production-parameter benchmark (res 256, blur cap 100) on a scaled-up
 * capsule: the lean solver vs the vendored JS reference (which trades ~3x the
 * memory for precomputed neighbors).
 *
 *   pnpm --filter @drawcall/skinning bench
 */

import { solveSkinWeights } from '../src/solve.js'
import { makeCapsule, makeCapsuleBones } from '../test/capsule.js'
import { computeBoneAssignment } from '../test/reference/bone-assignment.js'
import { computeSkinWeights } from '../test/reference/skin-weights.js'
import { computeVoxelVolume } from '../test/reference/voxel-volume.js'

const PARAMS = { resolution: 256, blurIterations: 100, orientationWeight: 2 }

// Dense rings approximate a real character's ~200k vertices
const mesh = makeCapsule({ radialSegments: 320, capRings: 80, bodyRings: 300 })
const bones = makeCapsuleBones()

let t = performance.now()
const volume = computeVoxelVolume(mesh.positions, mesh.indices, { resolution: PARAMS.resolution })
const voxelizeMs = performance.now() - t
const [dimX, dimY, dimZ] = volume.dimensions
console.log(
  `mesh: ${mesh.positions.length / 3} vertices, ${mesh.indices.length / 3} triangles\n` +
    `grid: ${dimX}x${dimY}x${dimZ} = ${dimX * dimY * dimZ} voxels, ${volume.insideIndices.length} inside ` +
    `(voxelize ${voxelizeMs.toFixed(0)}ms)`,
)

t = performance.now()
solveSkinWeights({
  positions: mesh.positions,
  volume,
  boneLines: bones,
  blurIterations: PARAMS.blurIterations,
  orientationWeight: PARAMS.orientationWeight,
})
console.log(`solver: ${(performance.now() - t).toFixed(0)}ms, rss ${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)}MB`)

t = performance.now()
const assignment = computeBoneAssignment(volume, bones, {
  boneCount: 4,
  blurIterations: PARAMS.blurIterations,
  orientationWeight: PARAMS.orientationWeight,
})
computeSkinWeights(mesh.positions, volume, assignment)
console.log(`reference: ${(performance.now() - t).toFixed(0)}ms`)
