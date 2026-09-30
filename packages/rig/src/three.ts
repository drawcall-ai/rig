/**
 * The three.js-native core, usable in Node and the browser: measure a scene
 * (section, parts) and bind it to a THREE.Bone tree (skin). Bones are plain
 * three.js: build them with new THREE.Bone(), parent them with add(), pose
 * them with rotation, return to the bind pose with skeleton.pose().
 *
 * Per-bone options live in bone.userData:
 *   tail: [x, y, z]  world-space end of the bone (default: its first child; a leaf extends its parent)
 *   deform: false    the bone is animated but attracts no weights
 *   pieces: [i, ...] bind these separate mesh pieces (indices from parts()) 100% to the bone; such a bone
 *                    drives only its pieces unless it also has deform: true
 */

import * as THREE from 'three'
import { sliceRegions, type Axis, type SliceResult } from './section.js'
import type { Skeleton, SkeletonBone } from './skeleton.js'
import { solveSkinWeights, type SolveInput, type SolveResult, type Vec3 } from './solve.js'
import { computeVoxelVolume, type VoxelVolume } from './voxelize.js'
import { computeWeights, meshParts, type SkinOptions, type SkinReport } from './weights.js'

export type { Axis, SliceRegion, SliceResult } from './section.js'
export type { BoneReport, SkinOptions, SkinReport } from './weights.js'

export interface BoneOptions {
  /** World-space end of the bone (default: its first child; a leaf extends its parent). */
  tail?: Vec3
  /** false: animated, but attracts no weights. With pieces: true to also take automatic weights. */
  deform?: boolean
  /** Separate mesh pieces (indices from parts()) bound 100% to this bone. */
  pieces?: number[]
}

/**
 * A THREE.Bone named `name` whose joint sits at `world` (world space), added under `parent`
 * (positions are converted to the parent's space). The options go to bone.userData.
 */
export function bone(name: string, world: Vec3, parent?: THREE.Bone, options: BoneOptions = {}): THREE.Bone {
  const b = new THREE.Bone()
  b.name = name
  b.position.set(...world)
  if (parent) {
    parent.updateMatrixWorld(true)
    parent.worldToLocal(b.position)
    parent.add(b)
  }
  Object.assign(b.userData, options)
  b.updateMatrixWorld(true)
  return b
}

/** The meshes of a scene as one world-space triangle soup (what section, parts and skin measure). */
interface Soup {
  meshes: THREE.Mesh[]
  /** First vertex of each mesh in `positions`. */
  offsets: number[]
  positions: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
}

const volumes = new WeakMap<THREE.Object3D, Map<number, VoxelVolume>>()

type Solve = (input: SolveInput) => SolveResult | Promise<SolveResult>
let solver: Solve = solveSkinWeights
/** Swaps the weight solver (the Node entry installs the multi-threaded one). */
export function useSolver(solve: Solve): void {
  solver = solve
}

/**
 * Solid regions where the plane axis=value cuts the scene, largest first, e.g. one region per leg at knee
 * height. center/min/max are keyed by the two in-plane axes ({x, z} for a y cut); value is the voxel layer
 * actually cut; null when the plane misses. Resolution = voxels along the longest axis (default 128).
 */
export function section(object: THREE.Object3D, axis: Axis, values: number[], resolution = 128): (SliceResult | null)[] {
  let byResolution = volumes.get(object)
  if (!byResolution) volumes.set(object, (byResolution = new Map()))
  let volume = byResolution.get(resolution)
  if (!volume) {
    const soup = gather(object)
    byResolution.set(resolution, (volume = computeVoxelVolume(soup.positions, soup.indices, { resolution })))
  }
  return values.map((value) => sliceRegions(volume, { axis, value }))
}

export interface Part {
  /** Index to use in bone.userData.pieces. */
  index: number
  /** Name of the mesh the piece belongs to. */
  mesh: string
  vertices: number
  min: Vec3
  max: Vec3
  center: Vec3
}

/** Separate mesh pieces (props, armor, eyes, glasses), largest first, in world space. */
export function parts(object: THREE.Object3D): Part[] {
  const soup = gather(object)
  return meshParts(soup.positions, soup.indices).map((part, index) => {
    const first = part.vertices[0]
    const mesh = soup.meshes[soup.offsets.findLastIndex((offset) => offset <= first)]
    return {
      index,
      mesh: mesh.name,
      vertices: part.vertices.length,
      min: part.min,
      max: part.max,
      center: [(part.min[0] + part.max[0]) / 2, (part.min[1] + part.max[1]) / 2, (part.min[2] + part.max[2]) / 2],
    }
  })
}

/**
 * Binds every mesh under `object` to the bone tree under `root`: computes skin weights, replaces each mesh
 * with a THREE.SkinnedMesh at the scene root (vertices baked to world space, so the bind pose is the model
 * as it is now) and removes any previous armature. Adds `root` to `object` if it has no parent. Returns
 * per-bone results and warnings that name the fix.
 */
export async function skin(object: THREE.Object3D, root: THREE.Bone, options: SkinOptions = {}): Promise<SkinReport> {
  object.updateMatrixWorld(true)
  if (!root.parent) object.add(root)
  root.updateMatrixWorld(true)
  const soup = gather(object)
  const bones: THREE.Bone[] = []
  root.traverse((node) => node instanceof THREE.Bone && bones.push(node))
  const skeleton: Skeleton = { bones: bones.map((bone) => toSkeletonBone(bone)) }
  const { skinIndices, skinWeights, report } = await computeWeights(soup.positions, soup.indices, skeleton, options, solver)

  // Remove the old armature first so no stale bone keeps a name the new one uses
  const newBones = new Set(bones)
  const oldBones: THREE.Bone[] = []
  object.traverse((node) => node instanceof THREE.Bone && !newBones.has(node) && oldBones.push(node))
  const three = new THREE.Skeleton(bones)
  soup.meshes.forEach((mesh, m) => {
    const offset = soup.offsets[m]
    const count = mesh.geometry.getAttribute('position').count
    const skinned = new THREE.SkinnedMesh(bakedGeometry(mesh), mesh.material)
    skinned.name = mesh.name
    skinned.userData = { ...mesh.userData }
    skinned.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices.slice(offset * 4, (offset + count) * 4), 4))
    skinned.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights.slice(offset * 4, (offset + count) * 4), 4))
    if (mesh.morphTargetInfluences) skinned.morphTargetInfluences = [...mesh.morphTargetInfluences]
    if (mesh.morphTargetDictionary) skinned.morphTargetDictionary = { ...mesh.morphTargetDictionary }
    mesh.removeFromParent()
    object.add(skinned)
    skinned.bind(three, new THREE.Matrix4())
  })
  for (const bone of oldBones) {
    let holdsMesh = false
    bone.traverse((node) => (holdsMesh ||= node instanceof THREE.Mesh))
    if (!holdsMesh) bone.removeFromParent()
  }
  const names = new Set(bones.map((bone) => bone.name))
  object.traverse((node) => {
    if (!newBones.has(node as THREE.Bone) && names.has(node.name)) node.name = `${node.name}_source`
  })
  volumes.delete(object)
  return report
}

function toSkeletonBone(bone: THREE.Bone): SkeletonBone {
  const data = bone.userData as { tail?: Vec3; deform?: boolean; pieces?: number[] }
  return {
    name: bone.name,
    parent: bone.parent instanceof THREE.Bone ? bone.parent.name : undefined,
    position: bone.getWorldPosition(new THREE.Vector3()).toArray(),
    tail: data.tail,
    deform: data.deform,
    pieces: data.pieces,
  }
}

/** World-space positions of every vertex of every mesh (skinned meshes in their current pose). */
function gather(object: THREE.Object3D): Soup {
  object.updateMatrixWorld(true)
  const meshes: THREE.Mesh[] = []
  object.traverse((node) => node instanceof THREE.Mesh && !node.userData.rigHelper && meshes.push(node))
  if (meshes.length === 0) throw new Error('no meshes under this object')
  const offsets: number[] = []
  let total = 0
  for (const mesh of meshes) {
    offsets.push(total)
    total += mesh.geometry.getAttribute('position').count
  }
  const positions = new Float32Array(total * 3)
  const indices: number[] = []
  const v = new THREE.Vector3()
  meshes.forEach((mesh, m) => {
    const position = mesh.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i)
      if (mesh instanceof THREE.SkinnedMesh) mesh.applyBoneTransform(i, v)
      v.applyMatrix4(mesh.matrixWorld).toArray(positions, (offsets[m] + i) * 3)
    }
    const index = mesh.geometry.getIndex()
    const count = index ? index.count : position.count
    for (let i = 0; i < count; i++) indices.push(offsets[m] + (index ? index.getX(i) : i))
  })
  return { meshes, offsets, positions, indices: new Uint32Array(indices) }
}

/** The mesh's geometry with positions (and normals, tangents, morph deltas) baked into world space. */
function bakedGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const geometry = mesh.geometry.clone()
  geometry.deleteAttribute('skinIndex')
  geometry.deleteAttribute('skinWeight')
  const position = geometry.getAttribute('position')
  const baked = new Float32Array(position.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i)
    if (mesh instanceof THREE.SkinnedMesh) mesh.applyBoneTransform(i, v)
    v.applyMatrix4(mesh.matrixWorld).toArray(baked, i * 3)
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(baked, 3))
  const linear = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld)
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
  const bake = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, matrix: THREE.Matrix3, unit: boolean) => {
    const out = new Float32Array(attribute.count * 3)
    for (let i = 0; i < attribute.count; i++) {
      v.fromBufferAttribute(attribute, i).applyMatrix3(matrix)
      if (unit) v.normalize()
      v.toArray(out, i * 3)
    }
    return new THREE.BufferAttribute(out, 3)
  }
  const normal = geometry.getAttribute('normal')
  if (normal) geometry.setAttribute('normal', bake(normal, normalMatrix, true))
  const morphs = geometry.morphAttributes as Record<string, (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[]>
  for (const [name, list] of Object.entries(morphs)) {
    morphs[name] = list.map((delta) => bake(delta, name === 'normal' ? normalMatrix : linear, false))
  }
  // A mirroring transform flips the winding once baked
  const index = geometry.getIndex()
  if (index && mesh.matrixWorld.determinant() < 0) {
    const flipped = Array.from({ length: index.count }, (_, i) => index.getX(i - (i % 3) + [0, 2, 1][i % 3]))
    geometry.setIndex(flipped)
  }
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
