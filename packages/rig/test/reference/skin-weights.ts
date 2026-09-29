/**
 * Vendored CPU reference — per-vertex skin weights from voxel bone weights.
 *
 * Source: /Users/bela/Documents/drawcall.ai/character/packages/rigged/src/skin-weights.ts
 * Adaptations (behavior-preserving): takes a raw positions array instead of a
 * THREE.BufferGeometry.
 */

import type { VoxelVolume } from './voxel-volume.js'
import type { BoneAssignment } from './bone-assignment.js'

export interface SkinWeightsResult {
  /** Bone indices for each vertex (4 per vertex, flattened) */
  skinIndices: Uint16Array
  /** Bone weights for each vertex (4 per vertex, flattened) */
  skinWeights: Float32Array
}

/**
 * For each vertex: find the nearest inside voxel, take that voxel's top 4 bones
 * by weight, normalize to sum 1. Falls back to bone 0 when nothing is found.
 */
export function computeSkinWeights(
  positions: Float32Array,
  volume: VoxelVolume,
  assignment: BoneAssignment,
): SkinWeightsResult {
  const numVertices = positions.length / 3
  const numBones = assignment.boneCount
  const weightsFlat = assignment.weightsFlat

  const [dimX, dimY, dimZ] = volume.dimensions
  const dimYZ = dimY * dimZ
  const isInsideFlat = volume.isInsideFlat
  const min = volume.min
  const invCellSize = 1 / volume.cellSize

  const skinIndices = new Uint16Array(numVertices * 4)
  const skinWeights = new Float32Array(numVertices * 4)

  const topBones = new Uint16Array(4)
  const topWeights = new Float32Array(4)

  for (let i = 0; i < numVertices; i++) {
    const vx = positions[i * 3]
    const vy = positions[i * 3 + 1]
    const vz = positions[i * 3 + 2]

    const cellIdx = findNearestInsideCellFast(
      vx, vy, vz, min[0], min[1], min[2], invCellSize,
      dimX, dimY, dimZ, dimYZ, isInsideFlat,
    )

    const baseIdx = i * 4

    if (cellIdx >= 0) {
      const weightBase = cellIdx * numBones

      // Find top 4 bones by weight (without allocations)
      topBones.fill(0)
      topWeights.fill(0)

      for (let b = 0; b < numBones; b++) {
        const w = weightsFlat[weightBase + b]
        if (w <= 0) continue

        // Insert into sorted top 4
        for (let j = 0; j < 4; j++) {
          if (w > topWeights[j]) {
            // Shift lower weights down
            for (let k = 3; k > j; k--) {
              topWeights[k] = topWeights[k - 1]
              topBones[k] = topBones[k - 1]
            }
            topWeights[j] = w
            topBones[j] = b
            break
          }
        }
      }

      const totalWeight = topWeights[0] + topWeights[1] + topWeights[2] + topWeights[3]

      if (totalWeight > 0) {
        const inv = 1 / totalWeight
        for (let j = 0; j < 4; j++) {
          skinIndices[baseIdx + j] = topBones[j]
          skinWeights[baseIdx + j] = topWeights[j] * inv
        }
      } else {
        skinIndices[baseIdx] = 0
        skinWeights[baseIdx] = 1
      }
    } else {
      // Vertex not found in grid - assign fully to bone 0 (usually root)
      skinIndices[baseIdx] = 0
      skinWeights[baseIdx] = 1
    }
  }

  return { skinIndices, skinWeights }
}

/**
 * Find the nearest inside cell for a world position using flat arrays.
 * Returns flat index or -1 if not found.
 */
function findNearestInsideCellFast(
  worldX: number, worldY: number, worldZ: number,
  minX: number, minY: number, minZ: number,
  invCellSize: number,
  dimX: number, dimY: number, dimZ: number, dimYZ: number,
  isInsideFlat: Uint8Array,
): number {
  // Direct lookup
  const directX = Math.floor((worldX - minX) * invCellSize)
  const directY = Math.floor((worldY - minY) * invCellSize)
  const directZ = Math.floor((worldZ - minZ) * invCellSize)

  if (
    directX >= 0 && directX < dimX &&
    directY >= 0 && directY < dimY &&
    directZ >= 0 && directZ < dimZ
  ) {
    const directIdx = directX * dimYZ + directY * dimZ + directZ
    if (isInsideFlat[directIdx]) {
      return directIdx
    }
  }

  // Clamp to valid range for search start
  const startX = Math.max(0, Math.min(dimX - 1, directX))
  const startY = Math.max(0, Math.min(dimY - 1, directY))
  const startZ = Math.max(0, Math.min(dimZ - 1, directZ))

  // Search in expanding radius (simplified - return first found)
  const maxRadius = 10

  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let x = Math.max(0, startX - radius); x <= Math.min(dimX - 1, startX + radius); x++) {
      for (let y = Math.max(0, startY - radius); y <= Math.min(dimY - 1, startY + radius); y++) {
        for (let z = Math.max(0, startZ - radius); z <= Math.min(dimZ - 1, startZ + radius); z++) {
          // Only check cells on boundary of this radius
          const onBoundary =
            Math.abs(x - startX) === radius ||
            Math.abs(y - startY) === radius ||
            Math.abs(z - startZ) === radius

          if (!onBoundary) continue

          const idx = x * dimYZ + y * dimZ + z
          if (isInsideFlat[idx]) {
            return idx
          }
        }
      }
    }
  }

  return -1
}
