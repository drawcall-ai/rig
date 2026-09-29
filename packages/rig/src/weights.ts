/**
 * The solver core, independent of any scene format: world-space triangles and
 * a skeleton in, per-vertex skin weights and a report with actionable warnings out.
 */

import { boneLines, resolveSkeleton, type ResolvedBone, type Skeleton } from './skeleton.js'
import { solveSkinWeights, type BoneLine, type Vec3 } from './solve.js'
import { computeVoxelVolume, type VoxelVolume } from './voxelize.js'

export interface SkinOptions {
  /** Voxels along the longest axis (default 128). Raise for thin parts (fingers, ears). */
  resolution?: number
  /** Weight smoothing passes (default 100; stops early on convergence). 0 = rigid. */
  blurIterations?: number
  /** Penalty for voxels off the ends of a bone rather than beside it (default 2). */
  orientationWeight?: number
}

export interface BoneReport {
  name: string
  deform: boolean
  /** Resolved end of the bone segment (explicit or default tail). */
  tail: Vec3
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
  vertices: number
  grid: { dimensions: [number, number, number]; cellSize: number; insideVoxels: number }
  bones: BoneReport[]
  /** Vertices no bone reached through the volume; bound rigidly to the nearest bone line. */
  unreachedVertices: number
  /** Weight that crossed a gap onto a part another bone owns: {from bone, onto the bone the vertices belong to, count}. */
  bleed: { from: string; onto: string; vertices: number }[]
  warnings: string[]
}

const DEFAULTS = { resolution: 128, blurIterations: 100, orientationWeight: 2 }

/**
 * Skin weights for a triangle soup in world space: voxelize, solve, then bind
 * unreached vertices and `pieces`, and build the per-bone report with warnings.
 * Weight slots index `skeleton.bones`.
 */
export function computeWeights(
  positions: Float32Array,
  indices: Uint32Array,
  skeleton: Skeleton,
  options: SkinOptions = {},
): { skinIndices: Uint16Array<ArrayBuffer>; skinWeights: Float32Array<ArrayBuffer>; report: SkinReport } {
  const { resolution, blurIterations, orientationWeight } = { ...DEFAULTS, ...options }
  const bones = resolveSkeleton(skeleton)
  const lines = boneLines(bones)
  const volume = computeVoxelVolume(positions, indices, { resolution })
  const solved = solveSkinWeights({ positions, volume, boneLines: lines, blurIterations, orientationWeight })
  // Pieces first: their vertices are settled and must not count as unreached or bleeding
  const pinned = bindPieces(bones, positions, indices, solved.skinIndices, solved.skinWeights)
  const unreachedVertices = bindUnreached(positions, solved.skinIndices, solved.skinWeights, lines)

  const report: SkinReport = {
    vertices: positions.length / 3,
    grid: { dimensions: volume.dimensions, cellSize: volume.cellSize, insideVoxels: volume.insideIndices.length },
    bones: boneReports(bones, volume, positions, solved.skinIndices, solved.skinWeights),
    unreachedVertices,
    bleed: findBleed(bones, lines, positions, solved.skinIndices, solved.skinWeights, pinned),
    warnings: [],
  }
  for (const [i, bone] of report.bones.entries()) {
    if (!bone.deform) continue
    const defaultLeafTail = bones[i].children.length === 0 && skeleton.bones[i].tail === undefined
    const hint = defaultLeafTail ? ` (it is a leaf using the default tail ${JSON.stringify(bone.tail)}; set "tail")` : ''
    if (bone.inside === 0) {
      report.warnings.push(`bone "${bone.name}": segment lies outside the mesh, so it gets no weights${hint}; move it inside`)
    } else if (bone.inside < 0.5) {
      report.warnings.push(
        `bone "${bone.name}": only ${Math.round(bone.inside * 100)}% of its segment is inside the mesh${hint}; ` +
          `only the inside part attracts weights`,
      )
    }
    if (bone.inside > 0 && bone.vertices === 0) {
      report.warnings.push(
        `bone "${bone.name}" is the main influence of no vertex (${bone.weighted} vertices have >=10% weight): ` +
          `no vertices lie mostly in its section, common on low-poly meshes. It still bends its children; ` +
          `to give it vertices, move its joints so a ring of vertices falls between them`,
      )
    }
  }
  for (const { from, onto, vertices } of report.bleed) {
    report.warnings.push(
      `bone "${from}" holds >=10% weight on ${vertices} vertices that belong to "${onto}" (much nearer to it): ` +
        `weight crossed a gap between touching parts. Move the joints apart, raise the resolution (e.g. 256), ` +
        `or bind separate pieces with "pieces"; check with a weight heatmap of "${from}"`,
    )
  }
  if (unreachedVertices > 0) {
    report.warnings.push(
      `${unreachedVertices} vertices are not connected to any bone through the volume (separate parts?) ` +
        `and were bound rigidly to the nearest bone`,
    )
  }
  return { skinIndices: solved.skinIndices, skinWeights: solved.skinWeights, report }
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
  const parts = meshParts(positions, indices)
  bones.forEach((bone, b) => {
    for (const piece of bone.pieces ?? []) {
      const part = parts[piece]
      if (!part) throw new Error(`bone "${bone.name}" names piece ${piece}, but the model has ${parts.length} pieces (0..${parts.length - 1})`)
      for (const v of part.vertices) {
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

/**
 * Weight that crossed a gap: a bone holding >= 10% on vertices that lie clearly
 * nearer a bone on another branch of the skeleton (a thigh on the
 * other leg, an arm on the chest it touches). Reported per bone pair.
 */
function findBleed(
  bones: ResolvedBone[],
  lines: BoneLine[],
  positions: Float32Array,
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
  pinned: Set<number>,
): { from: string; onto: string; vertices: number }[] {
  // Overlap along one chain (shin onto its own foot) is normal blending; only separate branches count
  const ancestor = (a: number, b: number) => {
    for (let i = bones[b].parentIndex; i >= 0; i = bones[i].parentIndex) if (i === a) return true
    return false
  }
  const related = (a: number, b: number) => a === b || ancestor(a, b) || ancestor(b, a)
  const counts = new Map<string, number>()
  for (let v = 0; v < positions.length / 3; v++) {
    if (pinned.has(v)) continue
    const distance = new Map<number, number>()
    for (const line of lines) {
      const d = segmentDistanceSq(positions, v * 3, line.start, line.end)
      distance.set(line.boneIndex, Math.min(distance.get(line.boneIndex) ?? Infinity, d))
    }
    let nearest = -1
    for (const [bone, d] of distance) if (nearest < 0 || d < (distance.get(nearest) as number)) nearest = bone
    for (let k = 0; k < 4; k++) {
      const bone = skinIndices[v * 4 + k]
      if (skinWeights[v * 4 + k] < 0.1 || related(bone, nearest)) continue
      // Clearly nearer: at least twice as far (4x squared) from the weighted bone as from the nearest one
      if ((distance.get(bone) ?? Infinity) < 4 * (distance.get(nearest) as number)) continue
      const key = `${bone}>${nearest}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const minimum = Math.max(25, 0.005 * (positions.length / 3))
  return [...counts]
    .filter(([, n]) => n >= minimum)
    .map(([key, n]) => {
      const [from, onto] = key.split('>').map(Number)
      return { from: bones[from].name, onto: bones[onto].name, vertices: n }
    })
    .sort((p, q) => q.vertices - p.vertices)
}

function segmentDistanceSq(p: Float32Array, o: number, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
  const apx = p[o] - a[0], apy = p[o + 1] - a[1], apz = p[o + 2] - a[2]
  const len2 = abx * abx + aby * aby + abz * abz
  const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t
  return dx * dx + dy * dy + dz * dz
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
    deform: bone.deform,
    tail: bone.tail,
    inside: bone.deform ? insideFraction(volume, bone.position, bone.tail) : 0,
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
function insideFraction(volume: VoxelVolume, start: Vec3, end: Vec3): number {
  const [dimX, dimY, dimZ] = volume.dimensions
  const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2])
  const steps = Math.max(1, Math.ceil(length / (volume.cellSize * 0.5)))
  let inside = 0
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = Math.floor((start[0] + (end[0] - start[0]) * t - volume.min[0]) / volume.cellSize)
    const y = Math.floor((start[1] + (end[1] - start[1]) * t - volume.min[1]) / volume.cellSize)
    const z = Math.floor((start[2] + (end[2] - start[2]) * t - volume.min[2]) / volume.cellSize)
    if (x < 0 || y < 0 || z < 0 || x >= dimX || y >= dimY || z >= dimZ) continue
    inside += volume.isInsideFlat[x * dimY * dimZ + y * dimZ + z]
  }
  return inside / (steps + 1)
}

/**
 * Separate mesh pieces: vertices connected through triangles, with coincident
 * vertices merged so UV and normal seams don't split a piece. Returns one
 * piece id per vertex (ids are arbitrary vertex indices).
 */
export function meshShells(positions: Float32Array, indices: Uint32Array): Int32Array {
  const count = positions.length / 3
  const parent = new Int32Array(count).map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b)
  }
  const byPosition = new Map<string, number>()
  for (let v = 0; v < count; v++) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`
    const first = byPosition.get(key)
    if (first === undefined) byPosition.set(key, v)
    else union(v, first)
  }
  for (let t = 0; t < indices.length; t += 3) {
    union(indices[t], indices[t + 1])
    union(indices[t], indices[t + 2])
  }
  return parent.map((_, v) => find(v))
}

export interface MeshPart {
  /** Vertex indices (into SceneGeometry.positions) of this separate piece. */
  vertices: number[]
  min: [number, number, number]
  max: [number, number, number]
}

/** Separate mesh pieces, largest first; indices into this list name pieces in `SkeletonBone.pieces`. */
export function meshParts(positions: Float32Array, indices: Uint32Array): MeshPart[] {
  const shell = meshShells(positions, indices)
  const parts = new Map<number, MeshPart>()
  for (let v = 0; v < shell.length; v++) {
    let part = parts.get(shell[v])
    if (!part) {
      part = { vertices: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
      parts.set(shell[v], part)
    }
    part.vertices.push(v)
    for (let a = 0; a < 3; a++) {
      part.min[a] = Math.min(part.min[a], positions[v * 3 + a])
      part.max[a] = Math.max(part.max[a], positions[v * 3 + a])
    }
  }
  // Ties broken by position so the order is stable across runs
  return [...parts.values()].sort((p, q) => q.vertices.length - p.vertices.length || p.min[0] - q.min[0] || p.min[1] - q.min[1] || p.min[2] - q.min[2])
}
