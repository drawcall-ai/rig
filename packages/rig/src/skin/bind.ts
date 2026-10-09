/** skin(): binds a scene's meshes to a THREE.Bone tree with computed weights. */

import * as THREE from 'three'
import { gather } from '../measure/soup.js'
import { checkResolution } from '../measure/voxelize.js'
import type { SkeletonBone } from './skeleton.js'
import { computeWeights, type SkinReport } from './weights.js'

/**
 * Binds every mesh under `object` to the bone tree under `root`: computes skin weights, replaces each mesh
 * with a THREE.SkinnedMesh at the scene root (vertices baked to world space, so the bind pose is the model
 * as it is now) and removes any previous armature. Adds `root` to `object` if it has no parent. Resolution =
 * voxels along the longest axis (default 128), as in section(). Returns per-bone results and warnings that
 * describe what the solver found.
 */
export async function skin(object: THREE.Object3D, root: THREE.Bone, resolution = 128): Promise<SkinReport> {
  checkResolution(resolution, 'skin(scene, root, 256)')
  object.updateMatrixWorld(true)
  if (!root.parent) object.add(root)
  root.updateMatrixWorld(true)
  const soup = gather(object)
  const bones: THREE.Bone[] = []
  root.traverse((node) => node instanceof THREE.Bone && bones.push(node))
  const { skinIndices, skinWeights, report } = await computeWeights(soup.positions, soup.indices, bones.map((bone) => toSkeletonBone(bone, root)), resolution)

  // Remove the old armature first so no stale bone keeps a name the new one uses
  const newBones = new Set<THREE.Object3D>(bones)
  const oldBones: THREE.Bone[] = []
  object.traverse((node) => node instanceof THREE.Bone && !newBones.has(node) && oldBones.push(node))
  const three = new THREE.Skeleton(bones)
  soup.meshes.forEach((mesh, m) => {
    const offset = soup.offsets[m]
    const count = mesh.geometry.getAttribute('position').count
    const bound = new THREE.SkinnedMesh(bakedGeometry(mesh), mesh.material)
    bound.name = mesh.name
    bound.userData = { ...mesh.userData }
    bound.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices.slice(offset * 4, (offset + count) * 4), 4))
    bound.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights.slice(offset * 4, (offset + count) * 4), 4))
    if (mesh.morphTargetInfluences) bound.morphTargetInfluences = [...mesh.morphTargetInfluences]
    if (mesh.morphTargetDictionary) bound.morphTargetDictionary = { ...mesh.morphTargetDictionary }
    mesh.removeFromParent()
    object.add(bound)
    bound.bind(three, new THREE.Matrix4())
  })
  // What hangs off the old armature without being part of it (the new root, points, lines, empties) stays, in place
  const old = new Set<THREE.Object3D>(oldBones)
  for (const bone of oldBones) for (const child of [...bone.children]) if (!old.has(child)) object.attach(child)
  for (const bone of oldBones) bone.removeFromParent()
  const names = new Set(bones.map((bone) => bone.name))
  object.traverse((node) => {
    if (!newBones.has(node) && names.has(node.name)) node.name = `${node.name}_source`
  })
  return report
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

/** The mesh's geometry with positions (and normals, morph deltas) baked into world space. */
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
  const morphs = geometry.morphAttributes
  if (morphs.position) morphs.position = morphs.position.map((delta) => bake(delta, linear, false))
  if (morphs.normal) morphs.normal = morphs.normal.map((delta) => bake(delta, normalMatrix, false))
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
