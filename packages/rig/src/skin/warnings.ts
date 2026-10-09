/**
 * What a solve found that may need a change, as warnings for the skin report:
 * bones outside the mesh, bones that get no vertices (with a joint position
 * that fixes it where there is one), weight that crossed between touching
 * parts, and vertices no bone reached.
 */

import { cellAt, isInside, type VoxelVolume } from '../measure/voxelize.js'
import { distance, distanceSqAt, segmentDistanceSq, segmentParameter, type Vec3 } from '../vec3.js'
import { boneLength, type ResolvedBone } from './skeleton.js'
import type { BoneLine } from './solve.js'
import type { BoneReport } from './weights.js'

/** Thickness is measured in voxels up to this; thicker parts report as this many or more. */
const MAX_THICKNESS = 9

export interface Outcome {
  bones: ResolvedBone[]
  lines: BoneLine[]
  positions: Float32Array
  volume: VoxelVolume
  resolution: number
  skinIndices: Uint16Array
  skinWeights: Float32Array
  reports: BoneReport[]
  /** Vertices bound rigidly to a bone's pieces. */
  pinned: Set<number>
  /** Vertices bound to the nearest bone because the solve reached none. */
  unreached: number
}

export function skinWarnings(outcome: Outcome): string[] {
  const { bones, positions, volume, resolution, reports, unreached } = outcome
  const warnings: string[] = []
  // Bones with no vertices of their own and no gap between vertex rings: their part is small on this grid
  const small: { name: string; thickness: number; length: number }[] = []
  for (const [i, bone] of reports.entries()) {
    if (!bones[i].deform) continue
    if (bone.inside === 0) {
      warnings.push(`bone "${bone.name}": its segment lies outside the mesh, so it gets no weights`)
      continue
    }
    if (bone.inside < 0.5) {
      warnings.push(`bone "${bone.name}": only ${Math.round(bone.inside * 100)}% of its segment lies inside the mesh, and only that part attracts weights`)
    }
    if (bone.vertices > 0) continue
    const gap = ringGap(bones, i, positions, volume.cellSize)
    if (!gap) {
      small.push({ name: bone.name, thickness: thickness(bones[i], volume), length: Math.round(boneLength(bones[i]) / volume.cellSize) })
      continue
    }
    const child = bones[bones[i].children[0]].name
    warnings.push(
      `bone "${bone.name}" is the main influence of no vertex (${bone.weighted} vertices have >=10% weight): ` +
        `no ring of vertices lies between its joint and "${child}"'s, common on low-poly meshes. It still bends its children. ` +
        `With its joint at about ${format(gap)}, a ring would lie between them.`,
    )
  }
  if (small.length > 0) {
    const names = small.map((bone) => `"${bone.name}"`)
    const listed = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more bones` : names.join(', ')
    warnings.push(
      `${listed} get no vertices of their own at resolution ${resolution} (voxel size ${+volume.cellSize.toPrecision(3)}): ` +
        `their parts are about ${range(small.map((bone) => bone.thickness), MAX_THICKNESS)} voxels thick and their segments ` +
        `${range(small.map((bone) => bone.length))} voxels long. They still bend their children.`,
    )
  }
  for (const { from, onto, vertices, center } of findBleed(outcome)) {
    warnings.push(`bone "${from}" holds >=10% weight on ${vertices} vertices around ${format(center)} that are much nearer "${onto}": the weight crossed between touching parts`)
  }
  if (unreached > 0) {
    warnings.push(`${unreached} vertices are not connected to any bone through the volume (separate pieces?) and are bound rigidly to the nearest bone`)
  }
  return warnings
}

const format = (p: Vec3) => `[${p.map((n) => +n.toPrecision(4)).join(', ')}]`

/** "low-high", or one number when they match; values at `max` or above show as "max+". */
function range(values: number[], max = Infinity): string {
  const [low, high] = [Math.min(...values), Math.max(...values)]
  const show = (n: number) => (n >= max ? `${max}+` : `${n}`)
  return low === high ? show(low) : `${show(low)}-${show(high)}`
}

/**
 * How many voxels across the solid is around the middle of a bone's segment: the first voxel outside it
 * lies about half that far out. Counts up to `MAX_THICKNESS`.
 */
function thickness(bone: ResolvedBone, volume: VoxelVolume): number {
  const middle = cellAt(volume, [0, 1, 2].map((a) => (bone.position[a] + bone.tail[a]) / 2))
  const reach = Math.ceil(MAX_THICKNESS / 2)
  for (let r = 1; r <= reach; r++) {
    for (let x = -r; x <= r; x++) {
      for (let y = -r; y <= r; y++) {
        for (let z = -r; z <= r; z++) {
          const d2 = x * x + y * y + z * z
          if (d2 > r * r || d2 <= (r - 1) * (r - 1)) continue
          if (!isInside(volume, [middle[0] + x, middle[1] + y, middle[2] + z])) return 2 * r - 1
        }
      }
    }
  }
  return MAX_THICKNESS
}

/**
 * Where a joint should go on a low-poly limb: vertices near the chain parent -> bone -> child are
 * projected onto it, and the middle of the empty stretch between vertex rings nearest the current
 * joint is returned (world space), or null when there is no clear gap. A gap narrower than two voxels
 * doesn't count: the grid can't separate the bones across it.
 */
function ringGap(bones: ResolvedBone[], index: number, positions: Float32Array, cellSize: number): Vec3 | null {
  const bone = bones[index]
  if (bone.parentIndex < 0) return null
  const a = bones[bone.parentIndex].position
  const b = bone.position
  const c = bone.tail
  const lengths = [distance(a, b), boneLength(bone)]
  const total = lengths[0] + lengths[1]
  if (!(total > 0)) return null
  const radius = total * 0.35
  // Arc-length position along the two-segment chain of every vertex close to it
  const along: number[] = []
  for (let v = 0; v < positions.length / 3; v++) {
    let best = Infinity
    let s = 0
    let beyond = false
    for (const [k, [p, q]] of [[a, b], [b, c]].entries()) {
      const raw = segmentParameter(positions, v * 3, p, q)
      const t = Math.max(0, Math.min(1, raw))
      const dist = distanceSqAt(positions, v * 3, p, q, t)
      if (dist < best) {
        best = dist
        s = (k === 0 ? 0 : lengths[0]) + t * lengths[k]
        // Past the chain's ends (not just past the middle joint) doesn't count
        beyond = (k === 0 && raw < -1e-6) || (k === 1 && raw > 1 + 1e-6)
      }
    }
    if (best < radius * radius && !beyond) along.push(s)
  }
  if (along.length === 0) return null
  along.sort((p, q) => p - q)
  // A joint in a gap whose far edge is a ring before the child leaves that ring between the joint and the
  // child, so the bone gets vertices. The chain start counts as a gap edge. Nearest such gap wins.
  const edges = [0, ...along.filter((s) => s < total - 1e-6)]
  let pick: number | null = null
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] - edges[i - 1] < Math.max(total * 0.1, 2 * cellSize)) continue
    const middle = (edges[i] + edges[i - 1]) / 2
    if (pick === null || Math.abs(middle - lengths[0]) < Math.abs(pick - lengths[0])) pick = middle
  }
  if (pick === null) return null
  const [p, q, t] = pick <= lengths[0] ? [a, b, pick / lengths[0]] : [b, c, (pick - lengths[0]) / lengths[1]]
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]
}

/**
 * Weight that crossed a gap: a bone holding >= 10% on vertices that lie clearly
 * nearer a bone on another branch of the skeleton (a thigh on the
 * other leg, an arm on the chest it touches). Reported per bone pair.
 */
function findBleed({ bones, lines, positions, skinIndices, skinWeights, pinned }: Outcome): { from: string; onto: string; vertices: number; center: Vec3 }[] {
  // Overlap along one chain (shin onto its own foot) is normal blending; only separate branches count
  const ancestor = (a: number, b: number) => {
    for (let i = bones[b].parentIndex; i >= 0; i = bones[i].parentIndex) if (i === a) return true
    return false
  }
  const related = (a: number, b: number) => a === b || ancestor(a, b) || ancestor(b, a)
  // Per bone pair: vertex count and the sum of their positions
  const found = new Map<string, { count: number; sum: [number, number, number] }>()
  for (let v = 0; v < positions.length / 3; v++) {
    if (pinned.has(v)) continue
    const distanceSq = new Map<number, number>()
    for (const line of lines) {
      const d = segmentDistanceSq(positions, v * 3, line.start, line.end)
      distanceSq.set(line.boneIndex, Math.min(distanceSq.get(line.boneIndex) ?? Infinity, d))
    }
    let nearest = -1
    let nearestSq = Infinity
    for (const [bone, d] of distanceSq) {
      if (nearest >= 0 && d >= nearestSq) continue
      nearest = bone
      nearestSq = d
    }
    for (let k = 0; k < 4; k++) {
      const bone = skinIndices[v * 4 + k]
      if (skinWeights[v * 4 + k] < 0.1 || related(bone, nearest)) continue
      // Clearly nearer: at least twice as far (4x squared) from the weighted bone as from the nearest one
      if ((distanceSq.get(bone) ?? Infinity) < 4 * nearestSq) continue
      const key = `${bone}>${nearest}`
      const entry = found.get(key) ?? { count: 0, sum: [0, 0, 0] }
      entry.count++
      for (let a = 0; a < 3; a++) entry.sum[a] += positions[v * 3 + a]
      found.set(key, entry)
    }
  }
  const minimum = Math.max(25, 0.005 * (positions.length / 3))
  return [...found]
    .filter(([, { count }]) => count >= minimum)
    .map(([key, { count, sum }]) => {
      const [from, onto] = key.split('>').map(Number)
      return { from: bones[from].name, onto: bones[onto].name, vertices: count, center: [sum[0] / count, sum[1] / count, sum[2] / count] satisfies Vec3 }
    })
    .sort((p, q) => q.vertices - p.vertices)
}
