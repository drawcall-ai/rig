/**
 * The solver core, independent of any scene format: world-space triangles and
 * a skeleton in, per-vertex skin weights and a report with warnings out.
 */

import { meshPieces } from '../measure/pieces.js'
import { cellAt, computeVoxelVolume, isInside, type VoxelVolume } from '../measure/voxelize.js'
import { segmentDistanceSq, type Vec3 } from '../vec3.js'
import { boneLength, boneLines, resolveSkeleton, type ResolvedBone, type SkeletonBone } from './skeleton.js'
import { solveSkinWeights, type BoneLine, type SolveInput, type SolveResult } from './solve.js'
import { skinWarnings } from './warnings.js'

export interface BoneReport {
  name: string
  /** Share of the segment inside the mesh volume, 0..1; only the inside part attracts weights. */
  inside: number
  /** Vertices whose largest weight is this bone. */
  vertices: number
  /** Vertices with at least 10% weight on this bone. */
  weighted: number
  /** World bounds of the `vertices` (null when none). */
  min: Vec3 | null
  max: Vec3 | null
}

export interface SkinReport {
  /** What the solver found that may need a change, one entry per cause. */
  warnings: string[]
  bones: BoneReport[]
}

export type Solve = (input: SolveInput) => SolveResult | Promise<SolveResult>

/** The solve computeWeights runs: single-threaded unless an entry swaps in another (the Node entry: solveParallel). */
let solver: Solve = solveSkinWeights

export function useSolver(solve: Solve): void {
  solver = solve
}

/** Weight smoothing passes (stops early on convergence). */
const BLUR_ITERATIONS = 100
/** Penalty for voxels off the ends of a bone rather than beside it. */
const ORIENTATION_WEIGHT = 2

/**
 * Skin weights for a triangle soup in world space: voxelize, solve, then bind
 * `pieces` and unreached vertices, and build the per-bone report with warnings.
 * Weight slots index `skeleton`.
 */
export async function computeWeights(
  positions: Float32Array,
  indices: Uint32Array,
  skeleton: SkeletonBone[],
  resolution: number,
): Promise<{ skinIndices: Uint16Array<ArrayBuffer>; skinWeights: Float32Array<ArrayBuffer>; report: SkinReport }> {
  const bones = resolveSkeleton(skeleton)
  const lines = boneLines(bones)
  const volume = computeVoxelVolume(positions, indices, { resolution })
  const { skinIndices, skinWeights } = await solver({ positions, volume, boneLines: lines, blurIterations: BLUR_ITERATIONS, orientationWeight: ORIENTATION_WEIGHT })
  // Pieces first: their vertices are settled and must not count as unreached or bleeding
  const pinned = bindPieces(bones, positions, indices, skinIndices, skinWeights)
  const unreached = bindUnreached(positions, skinIndices, skinWeights, lines)
  const reports = boneReports(bones, volume, positions, skinIndices, skinWeights)
  const warnings = skinWarnings({ bones, lines, positions, volume, resolution, skinIndices, skinWeights, reports, pinned, unreached })
  return { skinIndices, skinWeights, report: { warnings, bones: reports } }
}

/** Vertices with all-zero weights get weight 1 on the nearest bone line. */
function bindUnreached(positions: Float32Array, indices: Uint16Array, weights: Float32Array, lines: BoneLine[]): number {
  let count = 0
  for (let v = 0; v < positions.length / 3; v++) {
    if (weights[v * 4] > 0) continue
    let best = Infinity
    for (const line of lines) {
      const d = segmentDistanceSq(positions, v * 3, line.start, line.end)
      if (d < best) {
        best = d
        indices[v * 4] = line.boneIndex
      }
    }
    weights[v * 4] = 1
    count++
  }
  return count
}

/** Bones with `pieces` get those separate mesh pieces 100%. Returns the vertices bound this way. */
function bindPieces(
  bones: ResolvedBone[],
  positions: Float32Array,
  indices: Uint32Array,
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
): Set<number> {
  const pinned = new Set<number>()
  if (!bones.some((bone) => bone.pieces?.length)) return pinned
  const pieces = meshPieces(positions, indices)
  bones.forEach((bone, b) => {
    for (const index of bone.pieces ?? []) {
      const piece = pieces[index]
      if (!piece) throw new Error(`bone "${bone.name}" names piece ${index}, but the model has ${pieces.length} pieces (0..${pieces.length - 1})`)
      for (const v of piece.vertices) {
        pinned.add(v)
        skinIndices.fill(0, v * 4, v * 4 + 4)
        skinWeights.fill(0, v * 4, v * 4 + 4)
        skinIndices[v * 4] = b
        skinWeights[v * 4] = 1
      }
    }
  })
  return pinned
}

function boneReports(
  bones: ResolvedBone[],
  volume: VoxelVolume,
  positions: Float32Array,
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
): BoneReport[] {
  const reports: BoneReport[] = bones.map((bone) => ({
    name: bone.name,
    inside: bone.deform ? insideFraction(volume, bone) : 0,
    vertices: 0,
    weighted: 0,
    min: null,
    max: null,
  }))

  const min = bones.map(() => [Infinity, Infinity, Infinity])
  const max = bones.map(() => [-Infinity, -Infinity, -Infinity])
  for (let v = 0; v < positions.length / 3; v++) {
    let slot = 0
    for (let k = 0; k < 4; k++) {
      if (skinWeights[v * 4 + k] >= 0.1) reports[skinIndices[v * 4 + k]].weighted++
      if (skinWeights[v * 4 + k] > skinWeights[v * 4 + slot]) slot = k
    }
    const bone = skinIndices[v * 4 + slot]
    reports[bone].vertices++
    for (let a = 0; a < 3; a++) {
      min[bone][a] = Math.min(min[bone][a], positions[v * 3 + a])
      max[bone][a] = Math.max(max[bone][a], positions[v * 3 + a])
    }
  }
  for (const [i, report] of reports.entries()) {
    if (report.vertices === 0) continue
    report.min = [min[i][0], min[i][1], min[i][2]]
    report.max = [max[i][0], max[i][1], max[i][2]]
  }
  return reports
}

/** Samples the segment at half-cell steps, like the solver's seeding. */
function insideFraction(volume: VoxelVolume, bone: ResolvedBone): number {
  const { position: start, tail: end } = bone
  const steps = Math.max(1, Math.ceil(boneLength(bone) / (volume.cellSize * 0.5)))
  let inside = 0
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    if (isInside(volume, cellAt(volume, [0, 1, 2].map((a) => start[a] + (end[a] - start[a]) * t)))) inside++
  }
  return inside / (steps + 1)
}
