/**
 * skin(): voxelize the scene, solve weights for a skeleton, and rewrite the
 * document so every mesh is skinned to that skeleton.
 *
 * Output layout: a joint tree at the scene root (identity rotations, joint
 * world positions from the skeleton) and, per original mesh node, a new
 * skinned node at the scene root whose vertices are baked into world space.
 * The original nodes stay (keeping any children) but lose their mesh; morph
 * weight animations are retargeted to the new nodes. Pre-existing skins are
 * removed.
 */

import {
  PropertyType,
  type Accessor,
  type Buffer,
  type Document,
  type Mesh,
  type Node,
  type Primitive,
  type Root,
  type Skin,
} from '@gltf-transform/core'
import { boneLines, resolveSkeleton, type ResolvedBone, type Skeleton } from './skeleton.js'
import { determinant3, meshParts, readScene, transformNormal, transformPoint, transformVector, type ScenePart } from './scene.js'
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
  meshes: number
  grid: { dimensions: [number, number, number]; cellSize: number; insideVoxels: number }
  bones: BoneReport[]
  /** Vertices no bone reached through the volume; bound rigidly to the nearest bone line. */
  unreachedVertices: number
  /** Weight that crossed a gap onto a part another bone owns: {from bone, onto the bone the vertices belong to, count}. */
  bleed: { from: string; onto: string; vertices: number }[]
  warnings: string[]
}

const DEFAULTS = { resolution: 128, blurIterations: 100, orientationWeight: 2 }

export function skin(document: Document, skeleton: Skeleton, options: SkinOptions = {}): SkinReport {
  const { resolution, blurIterations, orientationWeight } = { ...DEFAULTS, ...options }
  const bones = resolveSkeleton(skeleton)
  const lines = boneLines(bones)
  const scene = readScene(document)

  const volume = computeVoxelVolume(scene.positions, scene.indices, { resolution })
  const solved = solveSkinWeights({ positions: scene.positions, volume, boneLines: lines, blurIterations, orientationWeight })
  const unreachedVertices = bindUnreached(scene.positions, solved.skinIndices, solved.skinWeights, lines)
  bindPieces(bones, scene.positions, scene.indices, solved.skinIndices, solved.skinWeights)

  writeSkin(document, bones, scene.parts, solved.skinIndices, solved.skinWeights)

  const report: SkinReport = {
    vertices: scene.positions.length / 3,
    meshes: new Set(scene.parts.map((part) => part.node)).size,
    grid: { dimensions: volume.dimensions, cellSize: volume.cellSize, insideVoxels: volume.insideIndices.length },
    bones: boneReports(bones, volume, scene.positions, solved.skinIndices, solved.skinWeights),
    unreachedVertices,
    bleed: findBleed(bones, lines, scene.positions, solved.skinIndices, solved.skinWeights),
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
  return report
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

/** Bones with `pieces` get those separate mesh pieces 100%. */
function bindPieces(
  bones: ResolvedBone[],
  positions: Float32Array,
  indices: Uint32Array,
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
): void {
  if (!bones.some((bone) => bone.pieces?.length)) return
  const parts = meshParts(positions, indices)
  bones.forEach((bone, b) => {
    for (const piece of bone.pieces ?? []) {
      const part = parts[piece]
      if (!part) throw new Error(`bone "${bone.name}" names piece ${piece}, but the model has ${parts.length} pieces (0..${parts.length - 1})`)
      for (const v of part.vertices) {
        skinIndices.fill(0, v * 4, v * 4 + 4)
        skinWeights.fill(0, v * 4, v * 4 + 4)
        skinIndices[v * 4] = b
        skinWeights[v * 4] = 1
      }
    }
  })
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
): { from: string; onto: string; vertices: number }[] {
  // Overlap along one chain (shin onto its own foot) is normal blending; only separate branches count
  const ancestor = (a: number, b: number) => {
    for (let i = bones[b].parentIndex; i >= 0; i = bones[i].parentIndex) if (i === a) return true
    return false
  }
  const related = (a: number, b: number) => a === b || ancestor(a, b) || ancestor(b, a)
  const counts = new Map<string, number>()
  for (let v = 0; v < positions.length / 3; v++) {
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

function writeSkin(
  document: Document,
  bones: ResolvedBone[],
  parts: ScenePart[],
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
): void {
  const root = document.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  const buffer = root.listBuffers()[0] ?? document.createBuffer()

  const joints = bones.map((bone) => document.createNode(bone.name))
  const inverseBindMatrices = new Float32Array(bones.length * 16)
  bones.forEach((bone, i) => {
    const parent = bone.parentIndex >= 0 ? bones[bone.parentIndex].position : [0, 0, 0]
    joints[i].setTranslation([bone.position[0] - parent[0], bone.position[1] - parent[1], bone.position[2] - parent[2]])
    if (bone.parentIndex >= 0) joints[bone.parentIndex].addChild(joints[i])
    else scene.addChild(joints[i])
    // Identity rotation, so the inverse bind matrix is a pure translation
    inverseBindMatrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bone.position[0], -bone.position[1], -bone.position[2], 1], i * 16)
  })
  const skin = document
    .createSkin('skeleton')
    .setSkeleton(joints[bones.findIndex((bone) => bone.parentIndex < 0)])
    .setInverseBindMatrices(document.createAccessor().setType('MAT4').setArray(inverseBindMatrices).setBuffer(buffer))
  for (const joint of joints) skin.addJoint(joint)

  const oldMeshes = new Set<Mesh>()
  const oldSkins = new Set<Skin>(root.listSkins().filter((other) => other !== skin))
  const oldJoints = new Set<Node>([...oldSkins].flatMap((other) => other.listJoints()))
  const skinnedNodes = new Map<Node, Node>()
  for (const part of parts) {
    let skinned = skinnedNodes.get(part.node)
    if (!skinned) {
      const mesh = part.node.getMesh() as Mesh
      const weights = mesh.getWeights()
      skinned = document
        .createNode(part.node.getName())
        .setMesh(document.createMesh(mesh.getName()).setWeights(weights))
        .setSkin(skin)
      if (part.node.getWeights().length > 0) skinned.setWeights(part.node.getWeights())
      scene.addChild(skinned)
      skinnedNodes.set(part.node, skinned)
      oldMeshes.add(mesh)
    }
    ;(skinned.getMesh() as Mesh).addPrimitive(bakePrimitive(document, buffer, part, skinIndices, skinWeights))
  }

  for (const [original, skinned] of skinnedNodes) {
    original.setMesh(null).setSkin(null)
    // Morph target animations drive the node that now carries the mesh
    for (const animation of root.listAnimations()) {
      for (const channel of animation.listChannels()) {
        if (channel.getTargetNode() === original && channel.getTargetPath() === 'weights') channel.setTargetNode(skinned)
      }
    }
  }
  for (const mesh of oldMeshes) disposeMeshIfUnused(mesh)
  for (const oldSkin of oldSkins) {
    if (oldSkin.listParents().some((parent) => parent.propertyType === PropertyType.NODE)) continue
    const ibm = oldSkin.getInverseBindMatrices()
    oldSkin.dispose()
    if (ibm) disposeIfUnused(ibm)
  }
  removeOldRig(root, oldJoints, new Set(joints))
}

/**
 * The replaced skins' joints are a dead armature now: remove the ones without
 * meshes below them, with their animation channels, and rename any other node
 * whose name collides with a new joint so the new names stay exact (engines
 * look bones up by name).
 */
function removeOldRig(root: Root, oldJoints: Set<Node>, newJoints: Set<Node>): void {
  const holdsMesh = (node: Node): boolean => !!node.getMesh() || node.listChildren().some(holdsMesh)
  const removed = new Set([...oldJoints].filter((joint) => !holdsMesh(joint)))
  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels()) {
      const target = channel.getTargetNode()
      if (!target || !removed.has(target)) continue
      const sampler = channel.getSampler()
      channel.dispose()
      if (sampler && !sampler.listParents().some((p) => p.propertyType === PropertyType.ANIMATION_CHANNEL)) sampler.dispose()
    }
    if (animation.listChannels().length === 0) animation.dispose()
  }
  for (const node of removed) node.dispose()
  const names = new Set([...newJoints].map((joint) => joint.getName()))
  for (const node of root.listNodes()) {
    if (!newJoints.has(node) && names.has(node.getName())) node.setName(`${node.getName()}_source`)
  }
}

/** A copy of the part's primitive with world-space vertex data and the new JOINTS_0/WEIGHTS_0. */
function bakePrimitive(
  document: Document,
  buffer: Buffer,
  part: ScenePart,
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
): Primitive {
  const primitive = part.primitive.clone()
  const { count, matrices } = part

  for (const semantic of primitive.listSemantics()) {
    if (semantic.startsWith('JOINTS_') || semantic.startsWith('WEIGHTS_')) primitive.setAttribute(semantic, null)
  }
  const bake = (accessor: Accessor | null, transform: typeof transformPoint, unit = false): Accessor | null => {
    if (!accessor) return null
    const out = new Float32Array(count * 3)
    const element: number[] = []
    for (let i = 0; i < count; i++) {
      transform(out, i * 3, matrices, i * 16, accessor.getElement(i, element))
      if (unit) normalize(out, i * 3)
    }
    return document.createAccessor().setType('VEC3').setArray(out).setBuffer(buffer)
  }
  primitive.setAttribute('POSITION', bake(primitive.getAttribute('POSITION'), transformPoint))
  primitive.setAttribute('NORMAL', bake(primitive.getAttribute('NORMAL'), transformNormal, true))
  const tangent = primitive.getAttribute('TANGENT')
  if (tangent) {
    const out = new Float32Array(count * 4)
    const element: number[] = []
    for (let i = 0; i < count; i++) {
      tangent.getElement(i, element)
      transformVector(out, i * 4, matrices, i * 16, element)
      normalize(out, i * 4)
      out[i * 4 + 3] = element[3]
    }
    primitive.setAttribute('TANGENT', document.createAccessor().setType('VEC4').setArray(out).setBuffer(buffer))
  }
  for (const target of primitive.listTargets()) {
    const copy = target.clone()
    copy.setAttribute('POSITION', bake(target.getAttribute('POSITION'), transformVector))
    copy.setAttribute('NORMAL', bake(target.getAttribute('NORMAL'), transformNormal))
    copy.setAttribute('TANGENT', bake(target.getAttribute('TANGENT'), transformVector))
    primitive.removeTarget(target).addTarget(copy)
  }

  // A mirroring transform flips the winding once baked into the vertices
  const indices = primitive.getIndices()
  if (determinant3(matrices, 0) < 0 && indices) {
    const flipped = new Uint32Array(indices.getArray() ?? [])
    for (let i = 0; i + 2 < flipped.length; i += 3) [flipped[i + 1], flipped[i + 2]] = [flipped[i + 2], flipped[i + 1]]
    primitive.setIndices(document.createAccessor().setType('SCALAR').setArray(flipped).setBuffer(buffer))
  }

  const joints = new Uint16Array(count * 4)
  joints.set(skinIndices.subarray(part.offset * 4, (part.offset + count) * 4))
  const weights = skinWeights.slice(part.offset * 4, (part.offset + count) * 4)
  primitive.setAttribute('JOINTS_0', document.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer))
  primitive.setAttribute('WEIGHTS_0', document.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer))
  return primitive
}

function normalize(out: Float32Array, o: number): void {
  const len = Math.hypot(out[o], out[o + 1], out[o + 2])
  if (len > 0) for (let k = 0; k < 3; k++) out[o + k] /= len
}

function disposeMeshIfUnused(mesh: Mesh): void {
  if (mesh.listParents().some((parent) => parent.propertyType === PropertyType.NODE)) return
  const accessors = new Set<Accessor>()
  for (const primitive of mesh.listPrimitives()) {
    const indices = primitive.getIndices()
    if (indices) accessors.add(indices)
    for (const accessor of primitive.listAttributes()) accessors.add(accessor)
    for (const target of primitive.listTargets()) {
      for (const accessor of target.listAttributes()) accessors.add(accessor)
      target.dispose()
    }
    primitive.dispose()
  }
  mesh.dispose()
  for (const accessor of accessors) disposeIfUnused(accessor)
}

/** Unreferenced accessors would still be serialized. */
function disposeIfUnused(accessor: Accessor): void {
  if (!accessor.listParents().some((parent) => parent.propertyType !== PropertyType.ROOT)) accessor.dispose()
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
