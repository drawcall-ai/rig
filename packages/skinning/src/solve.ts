/**
 * Skin-weight solver: per-bone geodesic BFS over inside voxels ->
 * orientation-penalized closest-bone assignment -> sparse top-4 weight blur
 * with early convergence exit -> per-vertex top-4 weights.
 *
 * Semantics mirror the vendored CPU reference (test/reference/, which mirrors
 * the original @drawcall/rigged library) with restructurings that provably do
 * not change the output, chosen to keep memory flat:
 * - Per-bone distance fields fold into one running best-dist/best-bone pair
 *   right after each bone's BFS (same strict-< compare in the same bone
 *   order), so memory is flat in the bone count.
 * - Distance/queued/blur state is stored per inside voxel, not per grid cell.
 * - Weights stay in the sparse top-4 representation end to end; the
 *   reference's dense round-trip and its post-blur normalization are
 *   identities under the final per-vertex top-4 normalization.
 * Float32Array stores round exactly where the reference's do, so results
 * match the reference bit-for-bit up to top-4 tie order.
 */

import type { VoxelVolume } from './voxelize.js'

export type Vec3 = readonly [number, number, number]

/** A bone as a line segment that attracts weights; several lines may share a boneIndex. */
export interface BoneLine {
  start: Vec3
  end: Vec3
  /** Joint index written to JOINTS_0. */
  boneIndex: number
  /** Terminal bones (leaves) skip the orientation penalty. */
  isTerminal: boolean
}

export interface SolveInput {
  /** World-space xyz per vertex, in the same space as the volume. */
  positions: Float32Array
  volume: Pick<VoxelVolume, 'min' | 'cellSize' | 'dimensions' | 'isInsideFlat' | 'insideIndices'>
  boneLines: BoneLine[]
  /** Blur pass cap; passes stop early once the weights converge. */
  blurIterations: number
  orientationWeight: number
}

export interface SolveResult {
  /** 4 bone indices per vertex */
  skinIndices: Uint16Array<ArrayBuffer>
  /**
   * 4 bone weights per vertex, normalized to sum 1. All four are 0 for a
   * vertex no bone reached (e.g. a shell disconnected from every bone line).
   */
  skinWeights: Float32Array<ArrayBuffer>
}

/** Bone indices are stored as bytes in the sparse weight representation. */
export const MAX_BONES_PER_SOLVE = 256

const EPSILON = 1e-6
const SQRT2 = Math.SQRT2
const SQRT3 = Math.sqrt(3)
const MAX_INFLUENCES = 4
const NEAREST_CELL_MAX_RADIUS = 10

// Blur kernel: aggressive diffusion (center=0 for max spread per iteration),
// weighted by manhattan distance: face=4, edge=2, corner=1.
const BLUR_WEIGHTS = new Float32Array([0, 4 / 56, 2 / 56, 1 / 56])

export function solveSkinWeights(input: SolveInput): SolveResult {
  const { positions, volume, boneLines } = input
  for (const bone of boneLines) {
    if (!Number.isInteger(bone.boneIndex) || bone.boneIndex < 0 || bone.boneIndex >= MAX_BONES_PER_SOLVE) {
      throw new Error(`boneIndex ${bone.boneIndex} outside [0, ${MAX_BONES_PER_SOLVE})`)
    }
  }
  const [dimX, dimY, dimZ] = volume.dimensions
  const dimYZ = dimY * dimZ
  const { isInsideFlat, insideIndices } = volume
  const [minX, minY, minZ] = volume.min
  const cellSize = volume.cellSize
  const numInside = insideIndices.length
  const numVertices = positions.length / 3

  // grid index -> local (inside-voxel) index
  const flatToLocal = new Uint32Array(dimX * dimYZ)
  for (let i = 0; i < numInside; i++) flatToLocal[insideIndices[i]] = i

  const dist = new Float32Array(numInside)
  const queued = new Uint8Array(numInside)
  const queue = new Uint32Array(numInside)
  const bestDist = new Float64Array(numInside).fill(Infinity)
  const bestBone = new Int16Array(numInside).fill(-1)

  for (const bone of boneLines) {
    // Geodesic BFS from the cells on the bone line: FIFO queue, each inside
    // voxel enqueued at most once, step costs 1/sqrt2/sqrt3 by manhattan
    // distance (the reference's computeDistanceField).
    dist.fill(Infinity)
    queued.fill(0)
    let tail = 0

    const seedCell = (px: number, py: number, pz: number): void => {
      const x = Math.floor((px - minX) / cellSize)
      const y = Math.floor((py - minY) / cellSize)
      const z = Math.floor((pz - minZ) / cellSize)
      if (x < 0 || x >= dimX || y < 0 || y >= dimY || z < 0 || z >= dimZ) return
      const idx = x * dimYZ + y * dimZ + z
      if (!isInsideFlat[idx]) return
      const local = flatToLocal[idx]
      if (dist[local] === 0) return
      dist[local] = 0
      queued[local] = 1
      queue[tail++] = idx
    }

    // Seed every cell touched when stepping along the line at half-cell
    // intervals (the reference's getCellsOnLine).
    const [sx, sy, sz] = bone.start
    let dirX = bone.end[0] - sx
    let dirY = bone.end[1] - sy
    let dirZ = bone.end[2] - sz
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ)
    if (len < EPSILON) {
      seedCell(sx, sy, sz)
    } else {
      dirX /= len
      dirY /= len
      dirZ /= len
      const step = cellSize * 0.5
      for (let t = 0; t <= len; t += step) {
        const tc = Math.min(t, len)
        seedCell(sx + dirX * tc, sy + dirY * tc, sz + dirZ * tc)
      }
    }

    let head = 0
    while (head < tail) {
      const idx = queue[head++]
      const cx = (idx / dimYZ) | 0
      const rem = idx - cx * dimYZ
      const cy = (rem / dimZ) | 0
      const cz = rem - cy * dimZ
      const currentDist = dist[flatToLocal[idx]]

      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx
        if (nx < 0 || nx >= dimX) continue
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy
          if (ny < 0 || ny >= dimY) continue
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue
            const nz = cz + dz
            if (nz < 0 || nz >= dimZ) continue

            const nidx = nx * dimYZ + ny * dimZ + nz
            if (!isInsideFlat[nidx]) continue

            const manhattan = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
            const stepDist = manhattan === 1 ? 1 : manhattan === 2 ? SQRT2 : SQRT3
            const newDist = currentDist + stepDist

            const nLocal = flatToLocal[nidx]
            if (newDist < dist[nLocal]) {
              dist[nLocal] = newDist
              if (!queued[nLocal]) {
                queued[nLocal] = 1
                queue[tail++] = nidx
              }
            }
          }
        }
      }
    }

    // Fold this bone's distance field into the running best (the reference's
    // assignClosestBones). Bones fold in array order with a strict < compare,
    // so ties resolve to the earlier bone exactly like the reference's inner
    // loop over bones.
    const lineX = bone.end[0] - sx
    const lineY = bone.end[1] - sy
    const lineZ = bone.end[2] - sz
    const len2 = lineX * lineX + lineY * lineY + lineZ * lineZ
    const invLineLen = len > EPSILON ? 1 / len : 0
    const bDirX = lineX * invLineLen
    const bDirY = lineY * invLineLen
    const bDirZ = lineZ * invLineLen

    for (let local = 0; local < numInside; local++) {
      const d = dist[local]
      if (d === Infinity) continue

      let adjustedDist = d
      if (d > EPSILON && !bone.isTerminal) {
        const idx = insideIndices[local]
        const x = (idx / dimYZ) | 0
        const rem = idx - x * dimYZ
        const y = (rem / dimZ) | 0
        const voxelX = minX + (x + 0.5) * cellSize
        const voxelY = minY + (y + 0.5) * cellSize
        const voxelZ = minZ + (rem - y * dimZ + 0.5) * cellSize

        const t =
          len2 < EPSILON * EPSILON
            ? 0
            : Math.max(
                0,
                Math.min(1, ((voxelX - sx) * lineX + (voxelY - sy) * lineY + (voxelZ - sz) * lineZ) / len2),
              )

        const toVoxelX = voxelX - (sx + lineX * t)
        const toVoxelY = voxelY - (sy + lineY * t)
        const toVoxelZ = voxelZ - (sz + lineZ * t)
        const toVoxelLen = Math.sqrt(toVoxelX * toVoxelX + toVoxelY * toVoxelY + toVoxelZ * toVoxelZ)

        if (toVoxelLen > EPSILON) {
          const invLen = 1 / toVoxelLen
          const parallelness = Math.abs(
            bDirX * toVoxelX * invLen + bDirY * toVoxelY * invLen + bDirZ * toVoxelZ * invLen,
          )
          adjustedDist = d * (1 + parallelness * input.orientationWeight)
        }
      }

      if (adjustedDist < bestDist[local]) {
        bestDist[local] = adjustedDist
        bestBone[local] = bone.boneIndex
      }
    }
  }

  // Sparse top-4 weights, initialized from the hard assignment
  const sparseBonesA = new Uint8Array(numInside * MAX_INFLUENCES)
  const sparseBonesB = new Uint8Array(numInside * MAX_INFLUENCES)
  const sparseWeightsA = new Float32Array(numInside * MAX_INFLUENCES)
  const sparseWeightsB = new Float32Array(numInside * MAX_INFLUENCES)
  const countA = new Uint8Array(numInside)
  const countB = new Uint8Array(numInside)
  for (let local = 0; local < numInside; local++) {
    if (bestBone[local] >= 0) {
      sparseBonesA[local * MAX_INFLUENCES] = bestBone[local]
      sparseWeightsA[local * MAX_INFLUENCES] = 1
      countA[local] = 1
    }
  }

  // Iterative blur over the 27-cell neighborhood (center at weight 0, exactly
  // like the reference's precomputed neighbor list), gathered on the fly.
  const boneSum = new Float32Array(MAX_BONES_PER_SOLVE)
  const boneSeen = new Uint8Array(MAX_BONES_PER_SOLVE)
  const seenList = new Uint8Array(MAX_BONES_PER_SOLVE)

  let actualIterations = 0
  for (let iter = 0; iter < input.blurIterations; iter++) {
    actualIterations = iter + 1
    const srcInA = iter % 2 === 0
    const srcBones = srcInA ? sparseBonesA : sparseBonesB
    const srcWeights = srcInA ? sparseWeightsA : sparseWeightsB
    const srcCount = srcInA ? countA : countB
    const dstBones = srcInA ? sparseBonesB : sparseBonesA
    const dstWeights = srcInA ? sparseWeightsB : sparseWeightsA
    const dstCount = srcInA ? countB : countA
    let maxChange = 0

    for (let local = 0; local < numInside; local++) {
      const idx = insideIndices[local]
      const x = (idx / dimYZ) | 0
      const rem = idx - x * dimYZ
      const y = (rem / dimZ) | 0
      const z = rem - y * dimZ

      let numSeen = 0
      let totalW = 0

      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        if (nx < 0 || nx >= dimX) continue
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= dimY) continue
          for (let dz = -1; dz <= 1; dz++) {
            const nz = z + dz
            if (nz < 0 || nz >= dimZ) continue
            const nidx = nx * dimYZ + ny * dimZ + nz
            if (!isInsideFlat[nidx]) continue

            const kw = BLUR_WEIGHTS[Math.abs(dx) + Math.abs(dy) + Math.abs(dz)]
            totalW += kw

            const nLocal = flatToLocal[nidx]
            const nCnt = srcCount[nLocal]
            const nBase = nLocal * MAX_INFLUENCES
            for (let i = 0; i < nCnt; i++) {
              const b = srcBones[nBase + i]
              if (!boneSeen[b]) {
                boneSeen[b] = 1
                seenList[numSeen++] = b
              }
              boneSum[b] += srcWeights[nBase + i] * kw
            }
          }
        }
      }

      const outBase = local * MAX_INFLUENCES
      const srcCnt = srcCount[local]
      let outCount = 0

      if (totalW > 0) {
        const inv = 1 / totalW

        // Selection sort for the top 4 (numSeen is small)
        const kMax = Math.min(numSeen, MAX_INFLUENCES)
        for (let k = 0; k < kMax; k++) {
          let maxIdx = k
          for (let j = k + 1; j < numSeen; j++) {
            if (boneSum[seenList[j]] > boneSum[seenList[maxIdx]]) maxIdx = j
          }
          if (maxIdx !== k) {
            const tmp = seenList[k]
            seenList[k] = seenList[maxIdx]
            seenList[maxIdx] = tmp
          }
          const b = seenList[k]
          const newW = boneSum[b] * inv
          if (newW > 0.001) {
            dstBones[outBase + outCount] = b
            dstWeights[outBase + outCount] = newW

            // Track change for convergence
            const oldW = outCount < srcCnt && srcBones[outBase + outCount] === b ? srcWeights[outBase + outCount] : 0
            const change = Math.abs(newW - oldW)
            if (change > maxChange) maxChange = change

            outCount++
          }
        }
      }
      dstCount[local] = outCount

      for (let i = 0; i < numSeen; i++) {
        boneSum[seenList[i]] = 0
        boneSeen[seenList[i]] = 0
      }
    }

    // Early convergence: stop if the max weight change is tiny
    if (maxChange < 0.001 && iter > 10) break
  }

  const finalInA = actualIterations % 2 === 0
  const finalBones = finalInA ? sparseBonesA : sparseBonesB
  const finalWeights = finalInA ? sparseWeightsA : sparseWeightsB
  const finalCount = finalInA ? countA : countB

  // Per-vertex weights (the reference's computeSkinWeights): nearest inside
  // cell, that cell's top-4 bones normalized to sum 1. Unlike the reference's
  // bone-0 fallback, unreached vertices keep all-zero weights for the caller.
  // Sparse entries are visited in ascending bone order so equal weights keep
  // the reference's lower-bone-index-first slot order.
  const skinIndices = new Uint16Array(numVertices * 4)
  const skinWeights = new Float32Array(numVertices * 4)
  const invCellSize = 1 / cellSize
  const entryBones = new Int32Array(MAX_INFLUENCES)
  const entryWeights = new Float32Array(MAX_INFLUENCES)
  const topBones = new Uint16Array(MAX_INFLUENCES)
  const topWeights = new Float32Array(MAX_INFLUENCES)

  for (let v = 0; v < numVertices; v++) {
    const cellIdx = findNearestInsideCell(
      positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2],
      minX, minY, minZ, invCellSize, dimX, dimY, dimZ, dimYZ, isInsideFlat,
    )
    const baseIdx = v * 4

    if (cellIdx < 0) continue

    const local = flatToLocal[cellIdx]
    const sBase = local * MAX_INFLUENCES
    const cnt = finalCount[local]
    for (let i = 0; i < cnt; i++) {
      entryBones[i] = finalBones[sBase + i]
      entryWeights[i] = finalWeights[sBase + i]
    }
    // Ascending bone order = the reference's dense iteration order
    for (let i = 1; i < cnt; i++) {
      const b = entryBones[i]
      const w = entryWeights[i]
      let j = i - 1
      while (j >= 0 && entryBones[j] > b) {
        entryBones[j + 1] = entryBones[j]
        entryWeights[j + 1] = entryWeights[j]
        j--
      }
      entryBones[j + 1] = b
      entryWeights[j + 1] = w
    }

    topBones.fill(0)
    topWeights.fill(0)
    for (let i = 0; i < cnt; i++) {
      const w = entryWeights[i]
      if (w <= 0) continue
      for (let j = 0; j < 4; j++) {
        if (w > topWeights[j]) {
          for (let k = 3; k > j; k--) {
            topWeights[k] = topWeights[k - 1]
            topBones[k] = topBones[k - 1]
          }
          topWeights[j] = w
          topBones[j] = entryBones[i]
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
    }
  }

  return { skinIndices, skinWeights }
}

/** Direct cell lookup, then an expanding boundary-shell search up to radius 10. */
function findNearestInsideCell(
  worldX: number, worldY: number, worldZ: number,
  minX: number, minY: number, minZ: number, invCellSize: number,
  dimX: number, dimY: number, dimZ: number, dimYZ: number,
  isInsideFlat: Uint8Array,
): number {
  const directX = Math.floor((worldX - minX) * invCellSize)
  const directY = Math.floor((worldY - minY) * invCellSize)
  const directZ = Math.floor((worldZ - minZ) * invCellSize)

  if (
    directX >= 0 && directX < dimX &&
    directY >= 0 && directY < dimY &&
    directZ >= 0 && directZ < dimZ
  ) {
    const directIdx = directX * dimYZ + directY * dimZ + directZ
    if (isInsideFlat[directIdx]) return directIdx
  }

  const startX = Math.max(0, Math.min(dimX - 1, directX))
  const startY = Math.max(0, Math.min(dimY - 1, directY))
  const startZ = Math.max(0, Math.min(dimZ - 1, directZ))

  for (let radius = 1; radius <= NEAREST_CELL_MAX_RADIUS; radius++) {
    for (let x = Math.max(0, startX - radius); x <= Math.min(dimX - 1, startX + radius); x++) {
      for (let y = Math.max(0, startY - radius); y <= Math.min(dimY - 1, startY + radius); y++) {
        for (let z = Math.max(0, startZ - radius); z <= Math.min(dimZ - 1, startZ + radius); z++) {
          const onBoundary =
            Math.abs(x - startX) === radius ||
            Math.abs(y - startY) === radius ||
            Math.abs(z - startZ) === radius
          if (!onBoundary) continue

          const idx = x * dimYZ + y * dimZ + z
          if (isInsideFlat[idx]) return idx
        }
      }
    }
  }

  return -1
}
