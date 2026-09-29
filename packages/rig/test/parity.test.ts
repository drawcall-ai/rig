/**
 * Voxelizer and solver vs the vendored CPU reference on a synthetic capsule,
 * across configs that cover the blur early-exit and the zero-blur path.
 *
 *   pnpm --filter @drawcall/skinning test
 */

import assert from 'node:assert/strict'
import { solveSkinWeights } from '../src/solve.js'
import { computeVoxelVolume as voxelize } from '../src/voxelize.js'
import { makeCapsule, makeCapsuleBones } from './capsule.js'
import { computeBoneAssignment } from './reference/bone-assignment.js'
import { computeSkinWeights } from './reference/skin-weights.js'
import { computeVoxelVolume } from './reference/voxel-volume.js'

const WEIGHT_TOLERANCE = 1e-6

/** Bone-id -> weight map of the 4 influence slots, ignoring zero-weight padding. */
function influences(indices: Uint16Array, weights: Float32Array, vertex: number): Map<number, number> {
  const map = new Map<number, number>()
  for (let j = 0; j < 4; j++) {
    const w = weights[vertex * 4 + j]
    if (w > 0) map.set(indices[vertex * 4 + j], w)
  }
  return map
}

const configs = [
  { name: 'res 48, blur 10', resolution: 48, blurIterations: 10, orientationWeight: 2 },
  { name: 'res 32, blur 100 (early exit)', resolution: 32, blurIterations: 100, orientationWeight: 2 },
  { name: 'res 48, blur 0 (hard assignment)', resolution: 48, blurIterations: 0, orientationWeight: 2 },
]

const mesh = makeCapsule()
const bones = makeCapsuleBones()
const numVertices = mesh.positions.length / 3

for (const config of configs) {
  const volume = computeVoxelVolume(mesh.positions, mesh.indices, { resolution: config.resolution })
  const ours = voxelize(mesh.positions, mesh.indices, { resolution: config.resolution })
  assert.deepEqual(ours.dimensions, volume.dimensions, `${config.name}: grid dimensions differ`)
  assert.deepEqual(ours.isInsideFlat, volume.isInsideFlat, `${config.name}: voxel occupancy differs`)

  const assignment = computeBoneAssignment(volume, bones, {
    boneCount: 4,
    blurIterations: config.blurIterations,
    orientationWeight: config.orientationWeight,
  })
  const reference = computeSkinWeights(mesh.positions, volume, assignment)

  const solved = solveSkinWeights({
    positions: mesh.positions,
    volume,
    boneLines: bones,
    blurIterations: config.blurIterations,
    orientationWeight: config.orientationWeight,
  })

  let maxDiff = 0
  for (let v = 0; v < numVertices; v++) {
    const expected = influences(reference.skinIndices, reference.skinWeights, v)
    const actual = influences(solved.skinIndices, solved.skinWeights, v)
    // The reference falls back to bone 0 where ours leaves unreached vertices unweighted
    if (actual.size === 0) {
      assert.deepEqual([...expected], [[0, 1]], `${config.name}: vertex ${v} unweighted but reference is not a fallback`)
      continue
    }
    assert.deepEqual(
      [...actual.keys()].sort(),
      [...expected.keys()].sort(),
      `${config.name}: vertex ${v} influence bones differ`,
    )
    for (const [bone, weight] of expected) {
      const diff = Math.abs((actual.get(bone) ?? 0) - weight)
      if (diff > maxDiff) maxDiff = diff
      assert.ok(diff <= WEIGHT_TOLERANCE, `${config.name}: vertex ${v} bone ${bone} weight off by ${diff}`)
    }
  }
  console.log(`parity ok: ${config.name} (${numVertices} vertices, max weight diff ${maxDiff.toExponential(2)})`)
}

console.log('parity.test.ts passed')
