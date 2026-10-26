/** skin(): binds a scene's meshes to a THREE.Bone tree with computed weights. */

import * as THREE from 'three'
import { gather } from '../measure/soup.js'
import { checkResolution } from '../measure/voxelize.js'
import type { SkeletonBone } from './skeleton.js'
import { computeWeights, type SkinReport, type SkinWeights } from './weights.js'
import { cacheKey, type SkinCache } from './cache.js'
import { assertTRS, saveRest } from './rest.js'

/**
 * Binds every mesh under a container `object` (such as a Scene or Group) to the bone tree under `root`:
 * computes skin weights and replaces each mesh
 * with a THREE.SkinnedMesh at the scene root (vertices baked into that root's coordinates, preserving
 * the current world-space bind pose) and removes any previous armature. Attaches an unparented `root` under `object`, preserving its world-space joints. Resolution =
 * voxels along the longest axis (default 128), as in section(). Returns per-bone results and warnings that
 * describe what the solver found. Attachments requiring shear fail before reparenting; bake nonuniform
 * scale into the model first. Pass options instead of a resolution to reuse weights from a cache.
 */
export async function skin(object: THREE.Object3D, root: THREE.Bone, options: number | SkinOptions = {}): Promise<SkinReport> {
  const { resolution = 128, cache } = typeof options === 'number' ? { resolution: options } : options
  if (object instanceof THREE.Mesh) throw new Error('skin() needs a container: add the mesh to a Group or Scene first')
  if (object === root) throw new Error('skin() needs a model container separate from the root bone; use a Group or Scene')
  checkResolution(resolution, 'skin(scene, root, 256)')
  object.updateWorldMatrix(true, false)
  object.updateMatrixWorld(true)
  root.updateWorldMatrix(true, true)
  const bones: THREE.Bone[] = []
  root.traverse((node) => node instanceof THREE.Bone && bones.push(node))
  const newBones = new Set<THREE.Object3D>(bones)
  const oldBones: THREE.Bone[] = []
  object.traverse((node) => node instanceof THREE.Bone && !newBones.has(node) && oldBones.push(node))
  const old = new Set<THREE.Object3D>(oldBones)
  const attachments = oldBones.flatMap((bone) => bone.children.filter((child) => !old.has(child) && !(child instanceof THREE.Mesh)))
  const worldToModel = object.matrixWorld.clone().invert()
  // Validate every planned attachment before changing the source scene or replacing geometry.
  const planned = root.parent ? attachments : [root, ...attachments]
  for (const child of planned) {
    const local = worldToModel.clone().multiply(child.matrixWorld)
    assertTRS(local, `skin(): attaching "${child.name}" would require shear; bake nonuniform scale before skin`)
  }
  if (!root.parent) object.attach(root)
  root.updateWorldMatrix(true, true)
  const soup = gather(object)
  const skeleton = bones.map((bone) => toSkeletonBone(bone, root))
  const { skinIndices, skinWeights, report } = cache
    ? await cachedWeights(cache, soup.positions, soup.indices, skeleton, resolution)
    : await computeWeights(soup.positions, soup.indices, skeleton, resolution)
  const three = new THREE.Skeleton(bones)
  soup.meshes.forEach((mesh, m) => {
    const offset = soup.offsets[m]
    const count = mesh.geometry.getAttribute('position').count
    const bound = new THREE.SkinnedMesh(bakedGeometry(mesh, worldToModel), mesh.material)
    bound.name = mesh.name
    bound.userData = { ...mesh.userData }
    bound.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices.slice(offset * 4, (offset + count) * 4), 4))
    bound.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights.slice(offset * 4, (offset + count) * 4), 4))
    if (mesh.morphTargetInfluences) bound.morphTargetInfluences = [...mesh.morphTargetInfluences]
    if (mesh.morphTargetDictionary) bound.morphTargetDictionary = { ...mesh.morphTargetDictionary }
    mesh.removeFromParent()
    object.add(bound)
    bound.updateWorldMatrix(true, false)
    bound.bind(three, object.matrixWorld)
  })
  // What hangs off the old armature without being part of it (the new root, points, lines, empties) stays, in place
  for (const child of attachments) object.attach(child)
  for (const bone of oldBones) bone.removeFromParent()
  const names = new Set(bones.map((bone) => bone.name))
  object.traverse((node) => {
    if (!newBones.has(node) && names.has(node.name)) node.name = `${node.name}_source`
  })
  bones.forEach(saveRest)
  return report
}

export interface SkinOptions {
  /** Voxels along the longest axis, as in section(). */
  resolution?: number
  /**
   * Keeps solved weights by a hash of everything that determines them (geometry, bones, resolution, rig
   * version): skinning the same input again skips the solve and gives identical weights.
   */
  cache?: SkinCache
}

/** A hit returns exactly what the solve would; the report is copied so the caller cannot edit the cached one. */
async function cachedWeights(
  cache: SkinCache,
  positions: Float32Array<ArrayBuffer>,
  indices: Uint32Array<ArrayBuffer>,
  skeleton: SkeletonBone[],
  resolution: number,
): Promise<SkinWeights> {
  const key = await cacheKey(positions, indices, skeleton, resolution)
  const hit = cache.get(key)
  const weights = hit ?? await computeWeights(positions, indices, skeleton, resolution)
  if (!hit) cache.set(key, weights)
  return { ...weights, report: structuredClone(weights.report) }
}

/** The root gets no skeleton parent, even when attached under a bone of the old armature. */
function toSkeletonBone(bone: THREE.Bone, root: THREE.Bone): SkeletonBone {
  return {
    name: bone.name,
    parent: bone !== root && bone.parent instanceof THREE.Bone ? bone.parent.name : undefined,
    position: bone.getWorldPosition(new THREE.Vector3()).toArray(),
    pieces: piecesOf(bone),
  }
}

/** bone.userData.pieces, checked: set by the caller, so anything can be there. */
function piecesOf(bone: THREE.Bone): number[] | undefined {
  const value: unknown = bone.userData.pieces
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every((index): index is number => Number.isInteger(index) && index >= 0)) return value
  throw new Error(`bone "${bone.name}".userData.pieces must be an array of piece indices, got ${JSON.stringify(value)}`)
}

/** Positions, normals and morph deltas baked into the destination model root's coordinates. */
function bakedGeometry(mesh: THREE.Mesh, worldToModel: THREE.Matrix4): THREE.BufferGeometry {
  const geometry = mesh.geometry.clone()
  geometry.deleteAttribute('skinIndex')
  geometry.deleteAttribute('skinWeight')
  const transform = new THREE.Matrix4().multiplyMatrices(worldToModel, mesh.matrixWorld)
  const position = geometry.getAttribute('position')
  const baked = new Float32Array(position.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i)
    if (mesh instanceof THREE.SkinnedMesh) mesh.applyBoneTransform(i, v)
    v.applyMatrix4(transform).toArray(baked, i * 3)
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(baked, 3))
  const linear = new THREE.Matrix3().setFromMatrix4(transform)
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(transform)
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
  const morphs = geometry.morphAttributes
  if (morphs.position) morphs.position = morphs.position.map((delta) => bake(delta, linear, false))
  if (morphs.normal) morphs.normal = morphs.normal.map((delta) => bake(delta, normalMatrix, false))
  // A mirroring transform flips the winding once baked
  const index = geometry.getIndex()
  if (index && transform.determinant() < 0) {
    const flipped = Array.from({ length: index.count }, (_, i) => index.getX(i - (i % 3) + [0, 2, 1][i % 3]))
    geometry.setIndex(flipped)
  }
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
