/**
 * Vendored CPU reference — geodesic distance fields, closest-bone assignment, weight blur.
 *
 * Source: /Users/bela/Documents/drawcall.ai/character/packages/rigged/src/bone-assignment.ts
 * Adaptations (behavior-preserving):
 * - THREE.Vector3 replaced by [x, y, z] tuples; bone lines carry precomputed
 *   `boneIndex`/`isTerminal` instead of names (see bones.ts for the name logic).
 * - Takes already-active bones plus an explicit `boneCount` (the original derived
 *   both from the skeleton via getActiveBones).
 * - The nested weights proxy and console logging are dropped.
 * Quirks of the original are kept verbatim (Uint8Array seenList of size 32, the
 * 0.001 keep-threshold, the `maxChange < 0.001 && iter > 10` early exit).
 */

import type { VoxelVolume } from './voxel-volume.js'
import { isValidCell } from './voxel-volume.js'

const EPSILON = 1e-6
const SQRT2 = Math.SQRT2
const SQRT3 = Math.sqrt(3)

// Blur kernel: aggressive diffusion (center=0 for max spread per iteration)
// Weights by manhattan distance: face=4, edge=2, corner=1
const BLUR_WEIGHTS = new Float32Array([0, 4 / 56, 2 / 56, 1 / 56])

export type Vec3 = readonly [number, number, number]

export interface BoneLine {
  boneIndex: number
  isTerminal: boolean
  start: Vec3
  end: Vec3
}

export interface BoneAssignment {
  weightsFlat: Float32Array
  boneCount: number
  dimensions: [number, number, number]
}

export interface BoneAssignmentOptions {
  /** Total number of bone slots (weights are indexed by BoneLine.boneIndex) */
  boneCount: number
  /** Blur iterations for weight smoothing (default: 50) */
  blurIterations?: number
  /** Orientation weight for bone direction preference (default: 2) */
  orientationWeight?: number
}

interface PrecomputedBone {
  boneIndex: number
  isTerminal: boolean
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirY: number
  dirZ: number
  lineX: number
  lineY: number
  lineZ: number
  len2: number
}

class GridHelper {
  readonly dimX: number
  readonly dimY: number
  readonly dimZ: number
  readonly dimYZ: number
  readonly totalVoxels: number

  constructor(dimensions: [number, number, number]) {
    ;[this.dimX, this.dimY, this.dimZ] = dimensions
    this.dimYZ = this.dimY * this.dimZ
    this.totalVoxels = this.dimX * this.dimY * this.dimZ
  }

  fromIndex(idx: number): [number, number, number] {
    const x = (idx / this.dimYZ) | 0
    const rem = idx - x * this.dimYZ
    const y = (rem / this.dimZ) | 0
    const z = rem - y * this.dimZ
    return [x, y, z]
  }
}

export function computeBoneAssignment(
  volume: VoxelVolume,
  activeBones: BoneLine[],
  options: BoneAssignmentOptions,
): BoneAssignment {
  const { boneCount, blurIterations = 50, orientationWeight = 2 } = options
  const grid = new GridHelper(volume.dimensions)
  const { insideIndices } = volume

  const geodesicDistances = computeGeodesicDistances(activeBones, volume, grid)

  // Step 1: Assign each voxel to closest bone (hard assignment)
  const closestBone = assignClosestBones(activeBones, geodesicDistances, volume, grid, orientationWeight)

  // Step 2: Initialize weights from hard assignment
  let weights = initializeWeights(closestBone, insideIndices, grid.totalVoxels, boneCount)

  // Step 3: Apply iterative blur to smooth the weights
  if (blurIterations > 0) {
    weights = applyBlurPasses(weights, volume, boneCount, blurIterations, grid)
    normalizeWeights(weights, insideIndices, boneCount)
  }

  return { weightsFlat: weights, boneCount, dimensions: volume.dimensions }
}

function computeGeodesicDistances(
  activeBones: BoneLine[],
  volume: VoxelVolume,
  grid: GridHelper,
): Float32Array[] {
  const queued = new Uint8Array(grid.totalVoxels)
  const queue = new Uint32Array(grid.totalVoxels * 3)
  return activeBones.map((bone) => computeDistanceField(bone, volume, grid, queued, queue))
}

export function computeDistanceFieldForBone(bone: BoneLine, volume: VoxelVolume): Float32Array {
  const grid = new GridHelper(volume.dimensions)
  return computeDistanceField(bone, volume, grid, new Uint8Array(grid.totalVoxels), new Uint32Array(grid.totalVoxels * 3))
}

function computeDistanceField(
  bone: BoneLine,
  volume: VoxelVolume,
  grid: GridHelper,
  queued: Uint8Array,
  queue: Uint32Array,
): Float32Array {
  const { isInsideFlat, insideIndices } = volume
  const { dimX, dimY, dimZ, dimYZ, totalVoxels } = grid
  const dist = new Float32Array(totalVoxels).fill(Infinity)

  for (const idx of insideIndices) queued[idx] = 0

  let head = 0
  let tail = 0

  for (const [x, y, z] of getCellsOnLine(bone.start, bone.end, volume)) {
    const idx = x * dimYZ + y * dimZ + z
    if (!isInsideFlat[idx] || dist[idx] === 0) continue
    dist[idx] = 0
    queued[idx] = 1
    queue[tail++] = x
    queue[tail++] = y
    queue[tail++] = z
  }

  while (head < tail) {
    const cx = queue[head++]
    const cy = queue[head++]
    const cz = queue[head++]
    const currentDist = dist[cx * dimYZ + cy * dimZ + cz]

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

          if (newDist < dist[nidx]) {
            dist[nidx] = newDist
            if (!queued[nidx]) {
              queued[nidx] = 1
              queue[tail++] = nx
              queue[tail++] = ny
              queue[tail++] = nz
            }
          }
        }
      }
    }
  }

  return dist
}

function precomputeBoneData(activeBones: BoneLine[]): PrecomputedBone[] {
  return activeBones.map((bone) => {
    const lineX = bone.end[0] - bone.start[0]
    const lineY = bone.end[1] - bone.start[1]
    const lineZ = bone.end[2] - bone.start[2]
    const len2 = lineX * lineX + lineY * lineY + lineZ * lineZ
    const len = Math.sqrt(len2)
    const invLen = len > EPSILON ? 1 / len : 0

    return {
      boneIndex: bone.boneIndex,
      isTerminal: bone.isTerminal,
      startX: bone.start[0],
      startY: bone.start[1],
      startZ: bone.start[2],
      dirX: lineX * invLen,
      dirY: lineY * invLen,
      dirZ: lineZ * invLen,
      lineX,
      lineY,
      lineZ,
      len2,
    }
  })
}

function assignClosestBones(
  activeBones: BoneLine[],
  distances: Float32Array[],
  volume: VoxelVolume,
  grid: GridHelper,
  orientationWeight: number,
): Int16Array {
  const closestBone = new Int16Array(grid.totalVoxels).fill(-1)
  const precomputed = precomputeBoneData(activeBones)
  const min = volume.min
  const cellSize = volume.cellSize

  for (const idx of volume.insideIndices) {
    const [x, y, z] = grid.fromIndex(idx)
    const voxelX = min[0] + (x + 0.5) * cellSize
    const voxelY = min[1] + (y + 0.5) * cellSize
    const voxelZ = min[2] + (z + 0.5) * cellSize

    let bestBoneIdx = -1
    let bestDist = Infinity

    for (let bi = 0; bi < precomputed.length; bi++) {
      const dist = distances[bi][idx]
      if (dist === Infinity) continue

      const bone = precomputed[bi]
      let adjustedDist = dist

      if (dist > EPSILON && !bone.isTerminal) {
        const t = bone.len2 < EPSILON * EPSILON ? 0 : Math.max(0, Math.min(1,
          ((voxelX - bone.startX) * bone.lineX +
           (voxelY - bone.startY) * bone.lineY +
           (voxelZ - bone.startZ) * bone.lineZ) / bone.len2
        ))

        const closestX = bone.startX + bone.lineX * t
        const closestY = bone.startY + bone.lineY * t
        const closestZ = bone.startZ + bone.lineZ * t

        const toVoxelX = voxelX - closestX
        const toVoxelY = voxelY - closestY
        const toVoxelZ = voxelZ - closestZ
        const toVoxelLen = Math.sqrt(toVoxelX * toVoxelX + toVoxelY * toVoxelY + toVoxelZ * toVoxelZ)

        if (toVoxelLen > EPSILON) {
          const invLen = 1 / toVoxelLen
          const parallelness = Math.abs(
            bone.dirX * toVoxelX * invLen +
            bone.dirY * toVoxelY * invLen +
            bone.dirZ * toVoxelZ * invLen
          )
          adjustedDist = dist * (1 + parallelness * orientationWeight)
        }
      }

      if (adjustedDist < bestDist) {
        bestDist = adjustedDist
        bestBoneIdx = bone.boneIndex
      }
    }

    closestBone[idx] = bestBoneIdx
  }

  return closestBone
}

function initializeWeights(
  closestBone: Int16Array,
  insideIndices: Uint32Array,
  totalVoxels: number,
  numBones: number,
): Float32Array {
  const weights = new Float32Array(totalVoxels * numBones)
  for (const idx of insideIndices) {
    if (closestBone[idx] >= 0) {
      weights[idx * numBones + closestBone[idx]] = 1
    }
  }
  return weights
}

/**
 * Apply iterative blur to smooth weight transitions.
 * Uses sparse representation (4 bones per voxel) and precomputed neighbors.
 */
function applyBlurPasses(
  weights: Float32Array,
  volume: VoxelVolume,
  numBones: number,
  iterations: number,
  grid: GridHelper,
): Float32Array {
  const { isInsideFlat, insideIndices } = volume
  const { dimX, dimY, dimZ, dimYZ, totalVoxels } = grid
  const numVoxels = insideIndices.length
  const MAX_BONES = 4 // 4 bones is sufficient for smooth skinning

  // Build local index mappings
  const flatToLocal = new Uint32Array(totalVoxels)
  for (let i = 0; i < numVoxels; i++) {
    flatToLocal[insideIndices[i]] = i
  }

  // Neighbor data: compact storage [nLocal, weight] pairs
  const neighborStart = new Uint32Array(numVoxels + 1)
  const tempData: number[] = []

  for (let localIdx = 0; localIdx < numVoxels; localIdx++) {
    neighborStart[localIdx] = tempData.length >> 1
    const idx = insideIndices[localIdx]
    const x = (idx / dimYZ) | 0
    const rem = idx - x * dimYZ
    const y = (rem / dimZ) | 0
    const z = rem - y * dimZ

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
          const manhattan = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
          tempData.push(flatToLocal[nidx], BLUR_WEIGHTS[manhattan])
        }
      }
    }
  }
  neighborStart[numVoxels] = tempData.length >> 1
  const neighborData = new Float32Array(tempData)

  // Sparse weight storage: [bone0, w0, bone1, w1, bone2, w2, bone3, w3]
  const sparseA = new Float32Array(numVoxels * MAX_BONES * 2)
  const sparseB = new Float32Array(numVoxels * MAX_BONES * 2)
  const countA = new Uint8Array(numVoxels)
  const countB = new Uint8Array(numVoxels)

  // Initialize from dense weights
  for (let localIdx = 0; localIdx < numVoxels; localIdx++) {
    const flatIdx = insideIndices[localIdx]
    const base = flatIdx * numBones
    const sBase = localIdx * MAX_BONES * 2
    for (let b = 0; b < numBones; b++) {
      if (weights[base + b] > 0) {
        sparseA[sBase] = b
        sparseA[sBase + 1] = 1.0
        countA[localIdx] = 1
        break
      }
    }
  }

  // Accumulators
  const boneSum = new Float32Array(numBones)
  const boneSeen = new Uint8Array(numBones)
  const seenList = new Uint8Array(32)

  let actualIterations = 0
  for (let iter = 0; iter < iterations; iter++) {
    actualIterations = iter + 1
    const src = iter % 2 === 0 ? sparseA : sparseB
    const dst = iter % 2 === 0 ? sparseB : sparseA
    const srcC = iter % 2 === 0 ? countA : countB
    const dstC = iter % 2 === 0 ? countB : countA

    let maxChange = 0

    for (let localIdx = 0; localIdx < numVoxels; localIdx++) {
      const nStart = neighborStart[localIdx] << 1
      const nEnd = neighborStart[localIdx + 1] << 1
      let numSeen = 0
      let totalW = 0

      // Gather from neighbors
      for (let n = nStart; n < nEnd; n += 2) {
        const nLocal = neighborData[n] | 0
        const kw = neighborData[n + 1]
        totalW += kw

        const nBase = nLocal * MAX_BONES * 2
        const nCnt = srcC[nLocal]
        for (let i = 0; i < nCnt; i++) {
          const b = src[nBase + i * 2] | 0
          const w = src[nBase + i * 2 + 1]
          if (boneSeen[b] === 0) {
            boneSeen[b] = 1
            seenList[numSeen++] = b
          }
          boneSum[b] += w * kw
        }
      }

      // Output top MAX_BONES
      const outBase = localIdx * MAX_BONES * 2
      const srcBase = localIdx * MAX_BONES * 2
      let outCount = 0

      if (totalW > 0) {
        const inv = 1 / totalW

        // Simple selection for top 4 (numSeen usually small)
        for (let k = 0; k < MAX_BONES && k < numSeen; k++) {
          let maxIdx = k
          for (let j = k + 1; j < numSeen; j++) {
            if (boneSum[seenList[j]] > boneSum[seenList[maxIdx]]) maxIdx = j
          }
          if (maxIdx !== k) {
            const t = seenList[k]; seenList[k] = seenList[maxIdx]; seenList[maxIdx] = t
          }
          const b = seenList[k]
          const newW = boneSum[b] * inv
          if (newW > 0.001) {
            dst[outBase + outCount * 2] = b
            dst[outBase + outCount * 2 + 1] = newW

            // Track change for convergence
            const oldW = outCount < srcC[localIdx] && src[srcBase + outCount * 2] === b
              ? src[srcBase + outCount * 2 + 1] : 0
            const change = Math.abs(newW - oldW)
            if (change > maxChange) maxChange = change

            outCount++
          }
        }
      }
      dstC[localIdx] = outCount

      // Reset accumulators
      for (let i = 0; i < numSeen; i++) {
        boneSum[seenList[i]] = 0
        boneSeen[seenList[i]] = 0
      }
    }

    // Early convergence: stop if max weight change is tiny
    if (maxChange < 0.001 && iter > 10) {
      break
    }
  }

  // Get final buffer
  const src = actualIterations % 2 === 0 ? sparseA : sparseB
  const srcC = actualIterations % 2 === 0 ? countA : countB

  // Convert back to dense
  const result = new Float32Array(totalVoxels * numBones)
  for (let localIdx = 0; localIdx < numVoxels; localIdx++) {
    const flatIdx = insideIndices[localIdx]
    const dBase = flatIdx * numBones
    const sBase = localIdx * MAX_BONES * 2
    const cnt = srcC[localIdx]
    for (let i = 0; i < cnt; i++) {
      result[dBase + (src[sBase + i * 2] | 0)] = src[sBase + i * 2 + 1]
    }
  }

  return result
}

function normalizeWeights(weights: Float32Array, insideIndices: Uint32Array, numBones: number): void {
  for (const idx of insideIndices) {
    const base = idx * numBones
    let sum = 0
    for (let b = 0; b < numBones; b++) sum += weights[base + b]
    if (sum > 0) {
      const invSum = 1 / sum
      for (let b = 0; b < numBones; b++) weights[base + b] *= invSum
    }
  }
}

/**
 * All grid cells touched by stepping along the bone line at half-cell intervals.
 * Exported so the GPU pipeline seeds distance fields with the identical cell set.
 */
export function getCellsOnLine(start: Vec3, end: Vec3, volume: VoxelVolume): [number, number, number][] {
  const { min, cellSize, dimensions } = volume
  const [, dimY, dimZ] = dimensions
  const dimYZ = dimY * dimZ
  let dirX = end[0] - start[0]
  let dirY = end[1] - start[1]
  let dirZ = end[2] - start[2]
  const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ)

  if (len < EPSILON) {
    const cell = worldToCell(start[0], start[1], start[2], min, cellSize, dimensions)
    return cell ? [cell] : []
  }

  dirX /= len
  dirY /= len
  dirZ /= len
  const step = cellSize * 0.5
  const cells: [number, number, number][] = []
  const seen = new Set<number>()

  for (let t = 0; t <= len; t += step) {
    const tc = Math.min(t, len)
    const cell = worldToCell(
      start[0] + dirX * tc,
      start[1] + dirY * tc,
      start[2] + dirZ * tc,
      min, cellSize, dimensions,
    )

    if (cell) {
      const key = cell[0] * dimYZ + cell[1] * dimZ + cell[2]
      if (!seen.has(key)) {
        seen.add(key)
        cells.push(cell)
      }
    }
  }

  return cells
}

function worldToCell(
  px: number, py: number, pz: number,
  min: [number, number, number],
  cellSize: number,
  dims: [number, number, number],
): [number, number, number] | null {
  const x = Math.floor((px - min[0]) / cellSize)
  const y = Math.floor((py - min[1]) / cellSize)
  const z = Math.floor((pz - min[2]) / cellSize)
  return isValidCell(x, y, z, dims) ? [x, y, z] : null
}
